# migrate.ps1 — 帶 token 呼叫 dev/migrate.ps1（參數原樣轉交）。
#
#   pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/migrate.ps1 -Status
#   'yes' | pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/migrate.ps1 -Apply -Only 0119_x.sql
#
# 非互動環境 Read-Host 會掛，所以 -Apply 一定要前面接 'yes' |。
$ErrorActionPreference = 'Stop'
$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root
. "$root/dev/lib/cred.ps1"
$env:SUPABASE_ACCESS_TOKEN = Get-SupabaseToken
& "$root/dev/migrate.ps1" @args
exit $LASTEXITCODE
