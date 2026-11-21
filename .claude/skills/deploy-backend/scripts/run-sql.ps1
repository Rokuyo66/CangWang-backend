# run-sql.ps1 — 透過 Management API 對正式庫跑一段 SQL，印出結果 JSON。
#
#   pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/run-sql.ps1 -File dev/postdeploy-check.sql
#   pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/run-sql.ps1 -Query "select now()"
#
# 會寫入的 SQL（insert/update/delete/DDL）只在六六確認過內容後才跑。
# migration 不要用這支，走 migrate.ps1（才有 _migrations 履歷）。

[CmdletBinding()]
param(
  [string]$File,
  [string]$Query,
  [string]$ProjectRef = 'ajogafvzlhqwlxwkfcpn'
)
$ErrorActionPreference = 'Stop'
$root = (git rev-parse --show-toplevel).Trim()
. "$root/dev/lib/cred.ps1"
if ($File) { $Query = [IO.File]::ReadAllText((Resolve-Path $File)) }
if (-not $Query) { throw '要給 -File 或 -Query' }

$body = New-TemporaryFile
[IO.File]::WriteAllText($body, (@{ query = $Query } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$token = Get-SupabaseToken
curl.exe -s -X POST "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data-binary "@$($body.FullName)"
Remove-Item $body
