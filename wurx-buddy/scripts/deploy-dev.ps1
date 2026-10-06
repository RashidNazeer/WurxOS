<#
============================================================
 Deploys automatic ingestion + the weekly TikTok re-crawl to the WurxOS DEV
 project, and nothing else. Windows PowerShell 5.1.

   powershell -ExecutionPolicy Bypass -File scripts\deploy-dev.ps1 -DryRun   # checks only, changes nothing
   powershell -ExecutionPolicy Bypass -File scripts\deploy-dev.ps1           # the deploy

 Run ONLY after the Owner has logged in (npx supabase login) and the Lead says go.

   (a) the CLI is logged in and can see the dev project
   (b) function secrets on DEV: OPEN_AI_API_KEY, AI_INGEST_SECRET from ..\.env.dev
       (a strong AI_INGEST_SECRET is generated and stored there if missing; never printed)
   (c) deploys ai-ingest and tts-crawl (--no-verify-jwt: they check x-webhook-secret)
   (d) applies 379, 380, 374, 375, 381 (scripts\db-dev.mjs, dev-guarded)
   (e) points app_config at the functions (scripts\deploy-dev-config.mjs)
   (f) smoke-checks the functions and prints the verification checklist

 Guard rails: the dev ref is hard-coded. The script refuses to run if any
 argument, environment variable, ..\.env.dev value or supabase\.temp link file
 names another project, and every CLI call passes --project-ref <dev> and
 --workdir <Assistant> explicitly (no `supabase link`, no config.toml needed:
 --workdir makes the CLI use Assistant\supabase\functions without searching
 upward). Production is never a possible target.
 Skip steps with -SkipSecrets, -SkipFunctions, -SkipMigrations, -SkipConfig.

 -DeployAssistant: deploy Wurx Buddy's `assistant` function instead (and nothing
 else): the same guards and dev ref; migrations 378, 383, 385, 386, 387, 389,
 395, 396, 397, 401 (already applied ones are skipped); the secrets step sets only
 the optional model keys from .env.dev when they are there: OPEN_AI_API_KEY_FALLBACK,
 GROQ_API_KEY (from GROQ_Fallback), GEMINI_API_KEY (from Gemini_Fallback), NVIDIA_API_KEY
 (from OPEN_AI_NVA), NVIDIA_API_KEY_2 (from NEM_API) (OPEN_AI_API_KEY is
 already set on dev; AI_INTERNAL_SECRET is optional, without it the Slack path
 is off); no app_config step. JWT verification stays ON for this function (callers are
 signed-in users), and it checks the caller's role itself
 (boss and developer always, plus ai_assistant_config.allowed_roles).
   powershell -ExecutionPolicy Bypass -File scripts\deploy-dev.ps1 -DeployAssistant -DryRun
============================================================
#>
[CmdletBinding()]
param(
  [switch]$DeployAssistant,
  [switch]$DryRun,
  [switch]$SkipSecrets,
  [switch]$SkipFunctions,
  [switch]$SkipMigrations,
  [switch]$SkipConfig
)
$ErrorActionPreference = 'Stop'

$DevRef    = 'vyvkwbvreeycmmnikqbz'                               # wurxos-dev
$Forbidden = @('xoaaidgvblondjpvxjqp', 'yrthghmzlbdmgwzaoeec')    # WurxOSV2 (production), gmv-intel
$Assistant = Split-Path -Parent $PSScriptRoot
$EnvFile   = Join-Path (Split-Path -Parent $Assistant) '.env.dev'
$Functions = @('ai-ingest', 'tts-crawl')
$Migrations = @('379', '380', '374', '375', '381')
$NoVerifyJwt = $true
if ($DeployAssistant) {
  $Functions = @('assistant')
  $Migrations = @('378', '383', '385', '386', '387', '389', '395', '396', '397', '401', '403', '404', '405')
  $NoVerifyJwt = $false
  $SkipConfig = $true
}

function Stop-Deploy([string]$why) { Write-Host "REFUSING: $why" -ForegroundColor Red; exit 1 }
function Step([string]$t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

# ---------------------------------------------------------------- guards
# Any 20-letter token on the command line that is not the dev ref.
foreach ($tok in [regex]::Matches([string]$MyInvocation.Line, '\b[a-z]{20}\b')) {
  if ($tok.Value -ne $DevRef) { Stop-Deploy "the command line names another project ref ($($tok.Value))." }
}
foreach ($v in Get-ChildItem Env:) {
  foreach ($f in $Forbidden) { if ([string]$v.Value -match $f) { Stop-Deploy "environment variable $($v.Name) names a forbidden project." } }
  if ($v.Name -match 'PROJECT_(REF|ID)$' -and [string]$v.Value -match '^[a-z]{20}$' -and $v.Value -ne $DevRef) {
    Stop-Deploy "environment variable $($v.Name) points at another project."
  }
}
if (-not (Test-Path $EnvFile)) { Stop-Deploy "$EnvFile not found." }
$envLines = [IO.File]::ReadAllLines($EnvFile)
$envMap = @{}
foreach ($l in $envLines) {
  if ($l -match '^\s*#' -or $l -notmatch '=') { continue }
  $i = $l.IndexOf('=')
  $envMap[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim().Trim('"').Trim("'")
}
if ($envMap['WURXOS_DEV_PROJECT_REF'] -ne $DevRef) { Stop-Deploy "WURXOS_DEV_PROJECT_REF in .env.dev is not $DevRef." }
foreach ($k in $envMap.Keys) {
  foreach ($f in $Forbidden) { if ([string]$envMap[$k] -match $f) { Stop-Deploy ".env.dev value $k names a forbidden project." } }
}
foreach ($dir in @((Join-Path $Assistant 'supabase\.temp'), (Join-Path (Split-Path -Parent $Assistant) 'supabase\.temp'))) {
  $pr = Join-Path $dir 'project-ref'
  if ((Test-Path $pr) -and ((Get-Content $pr -Raw).Trim() -ne $DevRef)) { Stop-Deploy "$pr links another project (run nothing; ask the Lead)." }
  $lp = Join-Path $dir 'linked-project.json'
  if (Test-Path $lp) {
    $ref = $null
    try { $ref = (Get-Content $lp -Raw | ConvertFrom-Json).ref } catch { }
    if ($ref -and $ref -ne $DevRef) { Stop-Deploy "$lp links another project ($ref)." }
  }
}
foreach ($fn in $Functions) {
  if (-not (Test-Path (Join-Path $Assistant "supabase\functions\$fn\index.ts"))) { Stop-Deploy "supabase\functions\$fn\index.ts not found." }
}

# Every CLI call goes through here: the dev ref and the Assistant workdir, always.
function Invoke-Supabase([string[]]$cliArgs) {
  $all = @($cliArgs) + @('--project-ref', $DevRef, '--workdir', $Assistant)
  foreach ($a in $all) { foreach ($f in $Forbidden) { if ($a -match $f) { Stop-Deploy "a CLI argument names a forbidden project." } } }
  & npx --yes supabase @all
  if ($LASTEXITCODE -ne 0) { throw "supabase $($cliArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

Push-Location $Assistant
try {
  Write-Host "Target: DEV $DevRef (wurxos-dev). Workdir: $Assistant" -ForegroundColor Yellow
  if ($DryRun) { Write-Host 'DRY RUN: checks only, nothing is changed.' -ForegroundColor Yellow }

  # ---------------------------------------------------------------- (a)
  Step '(a) Supabase CLI login'
  $projects = & npx --yes supabase projects list -o json
  if ($LASTEXITCODE -ne 0) { Stop-Deploy '`npx supabase projects list` failed: the Owner must run `npx supabase login` first.' }
  $list = ($projects | Out-String) | ConvertFrom-Json
  $dev = @($list | Where-Object { $_.id -eq $DevRef -or $_.ref -eq $DevRef })
  if (-not $dev.Count) { Stop-Deploy "the logged-in account cannot see the dev project $DevRef." }
  Write-Host "ok: logged in; dev project visible ($(@($list).Count) project(s) on the account; only $DevRef is used)."

  # ---------------------------------------------------------------- (b)
  Step '(b) function secrets on DEV'
  if ($SkipSecrets) { Write-Host 'skipped (-SkipSecrets)' }
  elseif ($DeployAssistant) {
    # Only the optional extra model keys (mig 397, 401): function secret <- .env.dev name.
    # Never echoed; the values go through a temp file that is deleted straight after.
    $extra = [ordered]@{ 'OPEN_AI_API_KEY_FALLBACK' = 'OPEN_AI_API_KEY_FALLBACK'; 'GROQ_API_KEY' = 'GROQ_Fallback'; 'GEMINI_API_KEY' = 'Gemini_Fallback'; 'NVIDIA_API_KEY' = 'OPEN_AI_NVA'; 'NVIDIA_API_KEY_2' = 'NEM_API' }
    $set = @($extra.Keys | Where-Object { $envMap[$extra[$_]] })
    foreach ($k in @($extra.Keys | Where-Object { -not $envMap[$extra[$_]] })) { Write-Host "$($extra[$k]) not in .env.dev: $k not set (that key's models stay off)." }
    if (-not $set.Count) { Write-Host 'nothing to set.' }
    elseif ($DryRun) { Write-Host "would run: supabase secrets set --env-file <temp file> --project-ref $DevRef   ($($set -join ', '))" }
    else {
      $tmpDir = Join-Path $env:TEMP 'claude'
      New-Item -ItemType Directory -Force $tmpDir | Out-Null
      $tmp = Join-Path $tmpDir ("deploy-dev-" + [guid]::NewGuid().ToString('N') + '.env')
      try {
        $lines = foreach ($k in $set) { "$k=$($envMap[$extra[$k]])" }
        [IO.File]::WriteAllText($tmp, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
        Invoke-Supabase @('secrets', 'set', '--env-file', $tmp)
      } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
      Write-Host "ok: $($set -join ', ') set on dev (not shown)."
    }
  }
  else {
    if (-not $envMap['OPEN_AI_API_KEY']) { Stop-Deploy 'OPEN_AI_API_KEY is missing in .env.dev.' }
    if (-not $envMap['AI_INGEST_SECRET']) {
      if ($DryRun) { Write-Host 'AI_INGEST_SECRET is not in .env.dev: the real run generates one (32 random bytes, hex) and stores it there.' }
      else {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes); $rng.Dispose()
        $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        $raw = [IO.File]::ReadAllText($EnvFile)
        $sep = if ($raw.Length -and -not $raw.EndsWith("`n")) { "`r`n" } else { '' }
        [IO.File]::AppendAllText($EnvFile, "$sep# ai-ingest / tts-crawl webhook secret (scripts\deploy-dev.ps1)`r`nAI_INGEST_SECRET=$secret`r`n", (New-Object Text.UTF8Encoding $false))
        $envMap['AI_INGEST_SECRET'] = $secret
        Write-Host 'generated a new AI_INGEST_SECRET and stored it in .env.dev (not shown).'
      }
    } else { Write-Host 'AI_INGEST_SECRET found in .env.dev (not shown).' }
    if ($DryRun) { Write-Host "would run: supabase secrets set --env-file <temp file> --project-ref $DevRef   (OPEN_AI_API_KEY, AI_INGEST_SECRET)" }
    else {
      # Values go through a temp file, never the command line; deleted straight after.
      $tmpDir = Join-Path $env:TEMP 'claude'
      New-Item -ItemType Directory -Force $tmpDir | Out-Null
      $tmp = Join-Path $tmpDir ("deploy-dev-" + [guid]::NewGuid().ToString('N') + '.env')
      try {
        [IO.File]::WriteAllText($tmp, "OPEN_AI_API_KEY=$($envMap['OPEN_AI_API_KEY'])`nAI_INGEST_SECRET=$($envMap['AI_INGEST_SECRET'])`n", (New-Object Text.UTF8Encoding $false))
        Invoke-Supabase @('secrets', 'set', '--env-file', $tmp)
      } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
      Write-Host 'ok: OPEN_AI_API_KEY and AI_INGEST_SECRET set on dev.'
    }
  }

  # ---------------------------------------------------------------- (c)
  Step '(c) deploy the edge functions'
  if ($SkipFunctions) { Write-Host 'skipped (-SkipFunctions)' }
  else {
    foreach ($fn in $Functions) {
      $deployArgs = @('functions', 'deploy', $fn) + $(if ($NoVerifyJwt) { @('--no-verify-jwt') } else { @() }) + @('--use-api')
      if ($DryRun) { Write-Host "would run: supabase $($deployArgs -join ' ') --project-ref $DevRef --workdir $Assistant" }
      else { Invoke-Supabase $deployArgs; Write-Host "ok: $fn deployed." }
    }
  }

  # ---------------------------------------------------------------- (d)
  Step "(d) migrations $($Migrations -join ', ')"
  if ($SkipMigrations) { Write-Host 'skipped (-SkipMigrations)' }
  elseif ($DryRun) { Write-Host "would run: node scripts\db-dev.mjs apply $($Migrations -join ' ')"; & node scripts\db-dev.mjs status }
  else {
    & node scripts\db-dev.mjs apply @Migrations
    if ($LASTEXITCODE -ne 0) { throw 'a migration failed (db-dev.mjs rolled it back); the ones before it stay applied.' }
  }

  # ---------------------------------------------------------------- (e)
  Step '(e) app_config: ai_ingest_url, ai_crawl_url, ai_ingest_secret'
  if ($SkipConfig) { Write-Host 'skipped (-SkipConfig)' }
  elseif ($DryRun) { & node scripts\deploy-dev-config.mjs --check }
  else {
    & node scripts\deploy-dev-config.mjs
    if ($LASTEXITCODE -ne 0) { throw 'deploy-dev-config.mjs failed.' }
  }

  # ---------------------------------------------------------------- (f)
  Step '(f) smoke check'
  if (-not $DryRun -and -not $SkipFunctions) {
    foreach ($fn in $Functions) {
      # No secret on purpose: our own 401 "Unauthorized" proves the function is live
      # and JWT checking is off (the gateway's JWT refusal is a JSON body instead).
      $url = "https://$DevRef.supabase.co/functions/v1/$fn"
      $code = 0; $body = ''
      try { $r = Invoke-WebRequest -Uri $url -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing; $code = [int]$r.StatusCode; $body = $r.Content }
      catch {
        $resp = $_.Exception.Response
        if ($resp) { $code = [int]$resp.StatusCode; $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() }
      }
      if ($DeployAssistant -and $code -eq 401) { Write-Host "ok: $fn answers 401 without a user token (live, JWT required)." }
      elseif ($code -eq 401 -and $body.Trim() -eq 'Unauthorized') { Write-Host "ok: $fn answers 401 Unauthorized without the secret (live, verify_jwt off)." }
      else { Write-Host "CHECK $fn by hand: got HTTP $code $($body.Substring(0, [Math]::Min(120, $body.Length)))" -ForegroundColor Yellow }
    }
  }
  if ($DeployAssistant) {
    Write-Host @"

Verification checklist (dev, assistant):
  1. npx supabase functions list --project-ref $DevRef --workdir "$Assistant"   -> assistant ACTIVE, verify_jwt true.
  2. node scripts\db-dev.mjs status   -> 378, 383, 385, 386, 387 listed.
  3. Signed in as the dev Boss: POST https://$DevRef.supabase.co/functions/v1/assistant
       {"message":"What does our SOP say about approving sample requests?","stream":true}
     -> SSE started, status..., delta..., sources, done{status:"done"}; the ai_messages row reaches status done.
  4. A user whose role is not boss / developer / in ai_assistant_config.allowed_roles gets 403.
"@
    return
  }
  Write-Host @"

Verification checklist (dev):
  1. npx supabase functions list --project-ref $DevRef --workdir "$Assistant"
       ai-ingest and tts-crawl ACTIVE, verify_jwt false.
  2. node scripts\db-dev.mjs status          -> 374, 375, 379, 380, 381 listed.
  3. SQL: select jobname, schedule from cron.job where jobname like 'ai-%';
       ai-ingest-tick * * * * *, ai-ingest-sweep 5 * * * *, ai-housekeeping 30 22 * * *,
       ai-tts-crawl-start 0 23 * * 6, ai-tts-crawl-tick * * * * *
  4. node scripts\deploy-dev-config.mjs --check   -> both URLs set, secret matches .env.dev.
  5. SQL: select public.ai_run_ingestion();   (or wait for the hourly check at :05)
       expect status swept; the first sweep queues the excluded "testing doc" soft delete
       ({"kb_article":{"not indexable":1}}) plus anything changed since the first ingestion.
  6. About 1 minute later:
       select id, status_code, left(content, 200) from net._http_response order by id desc limit 5;   -> 200
       select status from public.ai_documents where source_id = '833b9bda-8282-41dc-a8da-8ff3f032354d';   -> deleted
       select public.ai_ingest_stats();   -> queue drained, failed [], ignored_sources []
  7. Crawl: it starts on its own on Sunday 04:00 PKT. To run one now: select public.ai_crawl_start();
       then watch: select status, crawl_no, stats, last_error from public.ai_crawl_state;
       (~1,030 pages at ~3 s: about an hour; stats.retire_skipped must be null on a healthy crawl)
  8. After the crawl: the next sweep (or select public.ai_run_ingestion();) embeds only the changed articles.
Pause: see runbook-ingestion.md (cron.unschedule, or empty ai_ingest_url / ai_crawl_url).
"@
} finally {
  Pop-Location
}
