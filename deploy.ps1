# Deploy WurxOS to Vercel PRODUCTION using this project's own account token.
# No 'vercel login' / logout ever. The token lives in .vercel-token (gitignored);
# .vercel/project.json pins WHICH Vercel project/team it deploys to. Each project
# on this machine deploys as its own account just by running its own deploy.ps1.
#
# One-time setup:
#   1. Create a token at https://vercel.com/account/tokens (Expiration: No Expiration).
#   2. Save ONLY the token into a file named  .vercel-token  in this folder.
#   3. Run  .\deploy.ps1
$ErrorActionPreference = 'Stop'

$tokenFile = Join-Path $PSScriptRoot '.vercel-token'
if (-not (Test-Path $tokenFile)) {
  Write-Error ("Missing .vercel-token. Create a token at https://vercel.com/account/tokens and save it into " + $tokenFile)
  exit 1
}
$env:VERCEL_TOKEN = (Get-Content -Raw $tokenFile).Trim()

# Ensure the globally-installed vercel CLI resolves even in a stale-PATH shell
# (npm global bin on Windows lives under %APPDATA%\npm).
if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  $env:Path = (Join-Path $env:APPDATA 'npm') + ';' + $env:Path
}

Write-Host 'Deploying WurxOS to production (token account)...'
# --cwd pins vercel to THIS repo (where .vercel/project.json lives) no matter
# which folder the script is launched from, so it reads the linked org+project
# and never prompts for --scope or tries to set up the parent folder.
vercel --prod --yes --cwd $PSScriptRoot
