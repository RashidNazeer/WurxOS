$ErrorActionPreference = 'Stop'
$ff  = "C:\Users\Umar Ilyas\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe"
$in  = "$env:TEMP\claude\c--Users-Umar-Ilyas-WurxOS\ffc534e4-953a-40ad-9c7e-056a88ad0cc6\scratchpad\buddy2\rgba\f%04d.png"
$out = "C:\Users\Umar Ilyas\WurxOS\Assistant\assets\buddy\web"
New-Item -ItemType Directory -Force $out | Out-Null

# name, first frame (1-based @30fps), frame count, ping-pong
$clips = @(
  @('full',     1, 151, $false),   # 0.0-5.0 s, loops (starts/ends on the same smile)
  @('idle',     1,  28, $false),   # 0.0-0.9 s smile + slow blink
  @('thinking', 31, 64, $true),    # 1.0-3.1 s looks around, then "hmm"; ping-pong for a seamless loop
  @('happy',   100, 34, $false)    # 3.3-4.4 s squint smile -> laugh + wink
)
foreach ($c in $clips) {
  $name, $start, $count, $pp = $c
  $base = "fps=20,scale=192:192:flags=lanczos"
  $vf = if ($pp) { "$base,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0" } else { $base }
  & $ff -v error -y -framerate 30 -start_number $start -i $in -frames:v $count -filter_complex $vf `
      -c:v libwebp_anim -lossless 0 -q:v 70 -compression_level 6 -loop 0 -pix_fmt yuva420p "$out\buddy-$name.webp"
  $vf2 = if ($pp) { "fps=20,scale=256:256:flags=lanczos,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0" } else { "fps=20,scale=256:256:flags=lanczos" }
  & $ff -v error -y -framerate 30 -start_number $start -i $in -frames:v $count -filter_complex $vf2 `
      -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 42 -auto-alt-ref 0 -an "$out\buddy-$name.webm"
}
# Calm / reduced-motion still: relaxed smile at 0.5 s
foreach ($s in 128, 256, 512) {
  & $ff -v error -y -i ($in -replace '%04d','0016') -vf "scale=${s}:${s}:flags=lanczos" "$out\buddy-calm-$s.png"
}
Get-ChildItem $out | Sort-Object Name | ForEach-Object { '{0,-24} {1,8:N0} KB' -f $_.Name, ($_.Length/1KB) }

