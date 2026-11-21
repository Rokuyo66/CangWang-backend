# deploy-function.ps1 — 用 Supabase Management API 部署 Edge Function（取代被封鎖的 supabase.exe）。
#
#   pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/deploy-function.ps1 -Fn interpret -DryRun
#   pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/deploy-function.ps1 -Fn interpret,webhook-tg
#
# 守門（不過就不部署）：
#   - 必須在主 checkout 的 main、跟 origin/main 同一個 commit、supabase/functions 沒有未 commit 的改動。
#     理由：從 feature 分支或落後的 main 部署，會把另一台機器已上線的改動抹掉（2026-08-16 踩過）。
#   - -AllowStale 可以跳過，但只在六六明說時用。
# 每支 function 上傳 index.ts ＋ 整個 _shared/（忽略 *.bak*），verify_jwt=false（各支自己驗）。

[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$Fn,
  [switch]$DryRun,
  [switch]$AllowStale,
  [string]$ProjectRef = 'ajogafvzlhqwlxwkfcpn'
)
$ErrorActionPreference = 'Stop'
# pwsh -File 會把 "a,b" 當成一個字串傳進來，這裡自己拆
$Fn = @($Fn | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root
. "$root/dev/lib/cred.ps1"

git fetch --quiet origin
$branch = (git branch --show-current).Trim()
$head = (git rev-parse HEAD).Trim()
$om = (git rev-parse origin/main).Trim()
$dirty = git status --porcelain --untracked-files=no -- supabase/functions
$problems = @()
if ($branch -ne 'main') { $problems += "目前在 $branch，不是 main" }
if ($head -ne $om) { $problems += "HEAD $($head.Substring(0,7)) ≠ origin/main $($om.Substring(0,7))（先 git pull）" }
if ($dirty) { $problems += "supabase/functions 有未 commit 的改動" }
if ($problems -and -not $AllowStale) {
  Write-Host "✗ 不部署：`n  - $($problems -join "`n  - ")"
  exit 1
}

$token = Get-SupabaseToken
$api = "https://api.supabase.com/v1/projects/$ProjectRef"
$auth = "Authorization: Bearer $token"

$shared = Get-ChildItem "$root/supabase/functions/_shared" -Recurse -File |
  Where-Object { $_.Name -notmatch '\.bak' } |
  ForEach-Object { [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/') }

foreach ($f in $Fn) {
  $entry = "supabase/functions/$f/index.ts"
  if (-not (Test-Path "$root/$entry")) { Write-Host "✗ 找不到 $entry"; exit 1 }

  $before = curl.exe -s -H $auth "$api/functions/$f" | ConvertFrom-Json
  $lastCommit = (git log -1 --format=%cI -- "supabase/functions/$f" supabase/functions/_shared).Trim()
  $onlineAt = if ($before.updated_at) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$before.updated_at).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '(未部署)' }
  Write-Host "── $f：線上 v$($before.version)（$onlineAt），repo 最後相關 commit $lastCommit"

  $files = @($entry) + $shared
  if ($DryRun) { Write-Host "   [dry-run] 會上傳 $($files.Count) 個檔，未送出"; continue }

  $meta = New-TemporaryFile
  [IO.File]::WriteAllText($meta, (@{ name = $f; entrypoint_path = $entry; verify_jwt = $false } | ConvertTo-Json -Compress))
  $cargs = @('-s', '-X', 'POST', "$api/functions/deploy?slug=$f", '-H', $auth, '-F', "metadata=<$($meta.FullName)")
  foreach ($rel in $files) { $cargs += @('-F', "file=@$root/$rel;filename=$rel") }
  $res = & curl.exe @cargs
  Remove-Item $meta
  try { $j = $res | ConvertFrom-Json } catch { Write-Host "✗ $f 回應不是 JSON：$res"; exit 1 }
  if (-not $j.version) { Write-Host "✗ $f 部署失敗：$res"; exit 1 }
  Write-Host "   ✓ 已部署 v$($j.version)（status=$($j.status)）"
}
