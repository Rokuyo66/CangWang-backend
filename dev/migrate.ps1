# dev/migrate.ps1 — migration 走 Supabase Management API，不再手貼 SQL Editor。
#
# 手貼的問題不是麻煩，是「沒有履歷」：哪幾支跑過、在哪個環境跑過、跑的是哪一版內容，
# 全靠記憶。這支腳本把履歷落到 DB 的 _migrations 表，並在內容被改過時吼出來。
#
# 用法：
#   .\dev\migrate.ps1 -Status              # 只看狀態，什麼都不動（預設）
#   .\dev\migrate.ps1 -Baseline            # 首次使用：把現有已上線的 migration 標成已套用（不執行）
#   .\dev\migrate.ps1 -Apply               # 套用所有未套用的 migration
#   .\dev\migrate.ps1 -Apply -Only 0039_case_runs.sql
#
# Token：Supabase Management API token（sbp_ 開頭），依序找
#   -Token 參數 → $env:SUPABASE_ACCESS_TOKEN
# 拿法：supabase.com → Account → Access Tokens。不要寫進檔案、不要進 repo。

[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Baseline,
  [switch]$Apply,
  [string]$Only,
  [string]$Token = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef = "ajogafvzlhqwlxwkfcpn",
  [string]$MigrationDir = "supabase/migrations"
)

$ErrorActionPreference = 'Stop'
if (-not $Status -and -not $Baseline -and -not $Apply) { $Status = $true }

if (-not $Token) {
  Write-Host "找不到 Management API token。" -ForegroundColor Red
  Write-Host '設定方式：$env:SUPABASE_ACCESS_TOKEN = "sbp_..."（本 session 有效）'
  Write-Host '取得方式：supabase.com → Account → Access Tokens'
  exit 1
}

function Invoke-Sql {
  param([string]$Query)
  $body = @{ query = $Query } | ConvertTo-Json -Depth 3 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  try {
    return Invoke-RestMethod -Method Post `
      -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
      -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' } `
      -Body $bytes
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    throw "SQL 失敗：$detail"
  }
}

function Get-Sha256 {
  param([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    return ([System.BitConverter]::ToString($h) -replace '-', '').Substring(0, 16).ToLower()
  } finally { $sha.Dispose() }
}

# ── 本機 migration 檔 ───────────────────────────────────────────────
if (-not (Test-Path $MigrationDir)) { throw "找不到 $MigrationDir" }
$files = Get-ChildItem -Path $MigrationDir -Filter *.sql | Sort-Object Name
if (-not $files) { throw "$MigrationDir 裡沒有 .sql" }

# 撞號檢查：兩個檔搶同一個版本號，正是先前 db push 卡死的原因
$dupes = $files | Group-Object { ($_.Name -split '_')[0] } | Where-Object { $_.Count -gt 1 }
foreach ($d in $dupes) {
  Write-Host "⚠ 版本號 $($d.Name) 撞號：$($d.Group.Name -join ' / ')" -ForegroundColor Yellow
}

# 未進版控的本機檔（如 0017_reminders.sql）——換台機器就不存在，容易漏
$tracked = @(git ls-files $MigrationDir) | ForEach-Object { Split-Path $_ -Leaf }
$untracked = $files | Where-Object { $tracked -notcontains $_.Name }
foreach ($u in $untracked) {
  Write-Host "⚠ $($u.Name) 未進版控，換機器會找不到" -ForegroundColor Yellow
}

# ── 履歷表 ─────────────────────────────────────────────────────────
Invoke-Sql @"
create table if not exists public._migrations (
  name text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
"@ | Out-Null

$rows = Invoke-Sql "select name, checksum, applied_at from public._migrations order by name;"
$applied = @{}
foreach ($r in $rows) { $applied[$r.name] = $r }

# ── 比對 ───────────────────────────────────────────────────────────
$pending = @(); $drifted = @(); $ok = 0
foreach ($f in $files) {
  $sum = Get-Sha256 (Get-Content $f.FullName -Raw)
  if ($applied.ContainsKey($f.Name)) {
    if ($applied[$f.Name].checksum -ne $sum) { $drifted += [pscustomobject]@{ File = $f; Was = $applied[$f.Name].checksum; Now = $sum } }
    else { $ok++ }
  } else {
    $pending += [pscustomobject]@{ File = $f; Sum = $sum }
  }
}

Write-Host ""
Write-Host "專案 $ProjectRef　本機 $($files.Count) 支　已套用 $($applied.Count) 支" -ForegroundColor Cyan
Write-Host ("─" * 62)
Write-Host "  相符 $ok　待套用 $($pending.Count)　內容已變動 $($drifted.Count)"

foreach ($d in $drifted) {
  Write-Host "❌ $($d.File.Name) 已套用過，但檔案內容被改過（$($d.Was) → $($d.Now)）" -ForegroundColor Red
  Write-Host "   已套用的 migration 不可改。要改 schema 請另開一支新的。"
}
if ($pending) {
  Write-Host ""
  Write-Host "待套用："
  foreach ($p in $pending) { Write-Host "  · $($p.File.Name)" }
}

# ── 首次基準：把現有已上線的標成已套用，不執行 ─────────────────────
if ($Baseline) {
  if ($applied.Count -gt 0) { Write-Host "`n_migrations 已有 $($applied.Count) 筆，不需要再 baseline。" -ForegroundColor Yellow; exit 0 }
  Write-Host ""
  Write-Host "Baseline：把這 $($pending.Count) 支標記為『已套用』但不執行。" -ForegroundColor Yellow
  Write-Host "只有在這些 schema 確實已經在線上時才這樣做——標錯了往後就不會再跑。"
  $ans = Read-Host "確認？(yes/no)"
  if ($ans -ne 'yes') { Write-Host "取消。"; exit 0 }
  foreach ($p in $pending) {
    $n = $p.File.Name -replace "'", "''"
    Invoke-Sql "insert into public._migrations(name, checksum) values ('$n', '$($p.Sum)') on conflict (name) do nothing;" | Out-Null
    Write-Host "  標記 $($p.File.Name)"
  }
  Write-Host "`n✅ Baseline 完成，共 $($pending.Count) 支。往後只有新增的才會被套用。" -ForegroundColor Green
  exit 0
}

# ── 套用 ───────────────────────────────────────────────────────────
if ($Apply) {
  if ($drifted) { Write-Host "`n有 migration 內容被改過，先處理完再套用。" -ForegroundColor Red; exit 1 }
  $todo = if ($Only) { $pending | Where-Object { $_.File.Name -eq $Only } } else { $pending }
  if (-not $todo) { Write-Host "`n沒有要套用的。" -ForegroundColor Green; exit 0 }
  if ($applied.Count -eq 0) {
    Write-Host "`n❌ _migrations 是空的。線上若已有 schema，直接套用會重跑全部。" -ForegroundColor Red
    Write-Host "   先跑 .\dev\migrate.ps1 -Baseline 建立基準。"
    exit 1
  }

  Write-Host ""
  Write-Host "即將對 $ProjectRef 套用 $(@($todo).Count) 支 migration：" -ForegroundColor Yellow
  foreach ($t in $todo) { Write-Host "  · $($t.File.Name)" }
  $ans = Read-Host "確認？(yes/no)"
  if ($ans -ne 'yes') { Write-Host "取消。"; exit 0 }

  foreach ($t in $todo) {
    Write-Host "`n→ $($t.File.Name)"
    $sql = Get-Content $t.File.FullName -Raw
    # 整支包在交易裡：中途失敗就整支回滾，不留半套 schema
    Invoke-Sql "begin;`n$sql`n commit;" | Out-Null
    $n = $t.File.Name -replace "'", "''"
    Invoke-Sql "insert into public._migrations(name, checksum) values ('$n', '$($t.Sum)');" | Out-Null
    Write-Host "  ✅ 已套用並記錄"
  }
  Write-Host "`n✅ 完成 $(@($todo).Count) 支。" -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "（唯讀檢視。要套用加 -Apply；首次請先 -Baseline）"
