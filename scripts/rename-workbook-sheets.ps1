# ============================================================
# Rename sheets in an .xlsx by replacing ONLY xl/workbook.xml inside the zip.
#
#   powershell -ExecutionPolicy Bypass -File scripts\rename-workbook-sheets.ps1 `
#     -Workbook "C:\path\book.xlsx" -Plan "C:\path\sheet-rename-plan.json"
#
# Why not SheetJS: rewriting the workbook through a parser re-emits every
# worksheet. On this file that shifted each sheet's range (B4:AR37 -> A4:BG37,
# gaining a leading empty column) and would drop the comments, drawings, tables
# and threaded comments the workbook carries. Sheet names live only in the
# <sheet name="..."> entries of xl/workbook.xml; this workbook has no defined
# names and no cross-sheet formula references, so that one part is all that
# changes and every other entry is copied through byte for byte.
#
# The archive is rebuilt from scratch rather than opened in Update mode: Update
# mode produced a zip whose local header disagreed with the data it held
# ("Bad compressed size"), which no reader would open.
#
# plan.json is [{ "from": "Old name", "to": "New name" }, ...].
# Writes a NEW file; the original is never opened for writing.
# ============================================================
# Positional args, not a param() block: Windows PowerShell 5.1 refused to bind
# the named parameters here ("AmbiguousParameterSet") and $args sidesteps it.
#   args[0] = workbook path, args[1] = plan path, args[2] = output path (optional)
$Workbook = [string]$args[0]
$Plan     = [string]$args[1]
$OutFile  = if ($args.Count -ge 3) { [string]$args[2] } else { $null }
if (-not $Workbook -or -not $Plan) {
  throw 'usage: rename-workbook-sheets.ps1 <workbook.xlsx> <plan.json> [out.xlsx]'
}

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Workbook)) { throw "No such workbook: $Workbook" }
if (-not (Test-Path -LiteralPath $Plan)) { throw "No such plan: $Plan" }

$renames = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if (-not $renames) { throw "Plan is empty." }
$map = @{}
foreach ($r in $renames) { $map[[string]$r.from] = [string]$r.to }

if (-not $OutFile) {
  # .NET rather than Split-Path: in PS 5.1 -LiteralPath and -Parent sit in
  # different parameter sets and combining them is an AmbiguousParameterSet.
  $dir = [System.IO.Path]::GetDirectoryName($Workbook)
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Workbook)
  $OutFile = Join-Path $dir "$base (app names).xlsx"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---- 1. read every entry of the source into memory -------------------------
$src = [System.IO.Compression.ZipFile]::OpenRead($Workbook)
$names = @()
$blobs = @{}
try {
  foreach ($e in $src.Entries) {
    $ms = New-Object System.IO.MemoryStream
    $s = $e.Open()
    $s.CopyTo($ms)
    $s.Close()
    $names += $e.FullName
    $blobs[$e.FullName] = $ms.ToArray()
  }
}
finally { $src.Dispose() }
Write-Output ("Read {0} entries from the source." -f $names.Count)

# ---- 2. patch xl/workbook.xml ---------------------------------------------
$key = 'xl/workbook.xml'
if (-not $blobs.ContainsKey($key)) { throw "$key not found inside the workbook." }
$xml = [System.Text.Encoding]::UTF8.GetString($blobs[$key])

$script:changed = 0
$evaluator = {
  param($m)
  $whole = $m.Value
  $name = $m.Groups['name'].Value
  $plain = [System.Net.WebUtility]::HtmlDecode($name)
  if ($map.ContainsKey($plain)) {
    $newName = [System.Security.SecurityElement]::Escape($map[$plain])
    $script:changed++
    return ($whole -replace ('name="' + [regex]::Escape($name) + '"'), ('name="' + $newName + '"'))
  }
  return $whole
}
# One pass over the <sheet .../> elements, so a rename can never land on a name
# another rename is about to vacate.
$pattern = '<sheet\b[^>]*\bname="(?<name>[^"]*)"[^>]*/>'
$patched = [regex]::Replace($xml, $pattern, $evaluator)
if ($script:changed -eq 0) { throw "No sheet names matched the plan -- nothing written." }
$blobs[$key] = [System.Text.Encoding]::UTF8.GetBytes($patched)
Write-Output ("Patched {0}: {1} sheet name(s) changed." -f $key, $script:changed)

# ---- 3. write a brand-new archive, entry order preserved -------------------
if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
$out = [System.IO.Compression.ZipFile]::Open($OutFile, 'Create')
try {
  foreach ($n in $names) {
    $entry = $out.CreateEntry($n, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    $bytes = $blobs[$n]
    $es.Write($bytes, 0, $bytes.Length)
    $es.Close()
  }
}
finally { $out.Dispose() }

Write-Output ("Wrote {0} entries to:`n  {1}" -f $names.Count, $OutFile)
Write-Output ("Original untouched: {0}" -f $Workbook)
