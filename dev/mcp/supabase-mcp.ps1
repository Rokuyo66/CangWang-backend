# dev/mcp/supabase-mcp.ps1 — 啟動 Supabase 官方 MCP（唯讀），token 從憑證管理員現讀。
#
# .mcp.json（本機、已 gitignore）裡這樣接：
#   "supabase": { "command": "pwsh", "args": ["-NoProfile", "-File", "D:\\cangwang\\dev\\mcp\\supabase-mcp.ps1"] }
#
# --read-only：只能查，不能寫。部署與 migration 照舊走 dev/migrate.ps1 與 /deploy-backend。
# 版本釘住，升級前先看 changelog：https://github.com/supabase-community/supabase-mcp/releases

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/cred.ps1"
$env:SUPABASE_ACCESS_TOKEN = Get-SupabaseToken
& npx -y '@supabase/mcp-server-supabase@0.16.1' --read-only '--project-ref=ajogafvzlhqwlxwkfcpn'
exit $LASTEXITCODE
