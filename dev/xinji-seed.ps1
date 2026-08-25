# dev/xinji-seed.ps1 — 種一條「心事」進指定帳號，讓單一心事有東西可測。
#
# 為什麼要這支：一條心事要看得出味道，至少要三卦、而且要隔著時間。
# 手動在 APP 裡點三次，卦是同一天的、溫度線是一條平的，等於沒測到。
# 這支塞的是三張**真的排出來的卦**（水火既濟／火水未濟／水澤節），
# 妻財的月令旺衰刻意排成 休 → 囚 → 相，溫度線才會先掉下去再回來。
#
# 種進去的東西都帶 question_source = 'seed' 這個記號，-Undo 靠它整組收回，
# 不會誤傷他自己問的卦。
#
# 用法（Token 與 -ProjectRef 規則同 lingshi.ps1）：
#   .\dev\xinji-seed.ps1 -Email you@example.com          # 種一條（3 卦，56/15/1 天前）
#   .\dev\xinji-seed.ps1 -Email you@example.com -Undo    # 收回（只刪這支種的）
#   .\dev\xinji-seed.ps1 -Find 六六                      # 忘了帳號：先找人
#
# 注意：免費帳號同時只能在記 1 條心事。種之前先看他有沒有已經開著的，
# 不然「開新心事」那條路徑會被額度擋住——那不是 bug。

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,
  [string]$Find,
  [switch]$Undo,
  [string]$Token = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef = "ajogafvzlhqwlxwkfcpn"
)

$ErrorActionPreference = 'Stop'

if (-not $Token) {
  Write-Host "找不到 Management API token。" -ForegroundColor Red
  Write-Host '設定方式：$env:SUPABASE_ACCESS_TOKEN = "sbp_你自己那串"（本 session 有效）'
  Write-Host '取得方式：supabase.com → Account → Access Tokens'
  exit 1
}
if ($Token -match '^\s*sbp_\.+\s*$') {
  Write-Host "token 還是佔位字串（$Token）。" -ForegroundColor Red
  exit 1
}
if ($Token -notmatch '^sbp_') {
  Write-Host "這不像 Management API token——它是 sbp_ 開頭的那串。" -ForegroundColor Red
  Write-Host "（anon / service_role key 是 eyJ 開頭的 JWT，那兩把在這裡不能用。）"
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
    if ($detail -match 'JWT could not be decoded|Unauthorized|Invalid authentication') {
      throw "Token 不被接受（$detail）。要的是 supabase.com → Account → Access Tokens 那把 sbp_ 開頭的整串。"
    }
    throw "SQL 失敗：$detail"
  }
}

function Q { param([string]$s) "'" + ($s -replace "'", "''") + "'" }

# SQL 一律字串相接，整支不用 here-string——Windows PowerShell 5.1 的解析器對它挑剔。
# ⚠ 這一段（token 檢查／Invoke-Sql／Q／找人）與 lingshi.ps1、yudie.ps1、casts.ps1、
#   memory.ps1 是同一份。刻意複製而不抽成共用檔：這幾支是給非工程師在公司機上單獨
#   執行的，多一個 dot-source 的相對路徑就多一種「在他那台跑不起來」的方式。
#   改任何一支的這一段，記得五支一起改。

$IDENT_VIEW =
  "select pr.id, pr.display_name, pr.dao_name, pr.lingshi, pr.plan, " +
  "max(case when i.provider = 'web' then u.email end) as email, " +
  "max(case when i.provider = 'tg' then i.external_id end) as tg_id " +
  "from profiles pr " +
  "left join identities i on i.user_id = pr.id " +
  "left join auth.users u on i.provider = 'web' and u.id::text = i.external_id "


# ── 找人 ───────────────────────────────────────────────────────────
if ($Find) {
  $k = Q "%$Find%"
  $rows = Invoke-Sql ($IDENT_VIEW +
    "where pr.display_name ilike $k or pr.dao_name ilike $k " +
    "or u.email ilike $k or (i.provider = 'tg' and i.external_id ilike $k) " +
    "group by pr.id order by pr.created_at desc limit 20;")
  if (-not $rows) { Write-Host "找不到符合「$Find」的帳號。" -ForegroundColor Yellow; exit 1 }
  $rows | Format-Table id, display_name, email, tg_id, plan, lingshi -AutoSize
  Write-Host "挑一個，再用 -UserId / -Email / -TgId 指定。"
  exit 0
}


# ── 指定帳號 ───────────────────────────────────────────────────────
$given = @($Email, $TgId, $UserId) | Where-Object { $_ }
if ($given.Count -eq 0) {
  Write-Host "要指定帳號：-Email / -TgId / -UserId 擇一（或先 -Find 關鍵字 找人）。" -ForegroundColor Red
  exit 1
}
if ($given.Count -gt 1) { Write-Host "-Email / -TgId / -UserId 只能給一個。" -ForegroundColor Red; exit 1 }

if     ($UserId) { $where = "pr.id = " + (Q $UserId) + "::uuid" }
elseif ($Email)  { $where = "u.email = " + (Q $Email) }
else             { $where = "i.provider = 'tg' and i.external_id = " + (Q $TgId) }

$ids = @(Invoke-Sql (
  "select distinct pr.id from profiles pr " +
  "left join identities i on i.user_id = pr.id " +
  "left join auth.users u on i.provider = 'web' and u.id::text = i.external_id " +
  "where $where;"))
if ($ids.Count -eq 0) {
  Write-Host "查無此帳號。網頁帳號要先登入過一次才會有 profile。" -ForegroundColor Yellow
  exit 1
}
$inList = ($ids | ForEach-Object { (Q $_.id) + "::uuid" }) -join ", "
$hit = @(Invoke-Sql "$IDENT_VIEW where pr.id in ($inList) group by pr.id;")
if ($hit.Count -gt 1) {
  Write-Host "命中 $($hit.Count) 個帳號，改用 -UserId 指定其中一個：" -ForegroundColor Yellow
  $hit | Format-Table id, display_name, email, tg_id -AutoSize
  exit 1
}
$t = $hit[0]
$uid = Q $t.id
$who = if ($t.display_name) { $t.display_name } else { "(無暱稱)" }
if ($t.email) { $who += "　$($t.email)" }
if ($t.tg_id) { $who += "　tg:$($t.tg_id)" }
Write-Host ""
Write-Host "帳號 $($t.id)" -ForegroundColor Cyan
Write-Host "     $who　方案 $($t.plan)"


# ── 收回 ───────────────────────────────────────────────────────────
# 先刪卦拿到 thread_id，再刪那些心事（thread_notes 靠 cascade 一起走）。
# casts.thread_id 是 on delete set null，順序反過來會留下孤兒卦。
if ($Undo) {
  $sql =
    "with gone as (delete from casts where user_id = $uid::uuid " +
    "and question_source = 'seed' returning thread_id), " +
    "th as (delete from threads where id in " +
    "(select distinct thread_id from gone where thread_id is not null) returning 1) " +
    "select (select count(*) from gone) as casts, (select count(*) from th) as threads;"
  $r = @(Invoke-Sql $sql)[0]
  if ([int]$r.casts -eq 0) {
    Write-Host "`n這個帳號沒有這支種過的東西（question_source = 'seed'）。" -ForegroundColor Yellow
    exit 0
  }
  Write-Host "`n✅ 收回 $($r.casts) 卦、$($r.threads) 條心事。他自己問的卦沒動。" -ForegroundColor Green
  exit 0
}


# ── 現況：免費帳號只能在記 1 條 ────────────────────────────────────
$open = @(Invoke-Sql (
  "select count(*) as n from threads where user_id = $uid::uuid and status = 'open';"))[0]
$PLAN_THREADS = @{ free = 1; guanwei = 3; zhiji = 8; cangwang = 20 }
$cap = $PLAN_THREADS[[string]$t.plan]
if (-not $cap) { $cap = 1 }
Write-Host "     目前在記 $($open.n) 條心事（$($t.plan) 上限 $cap）"
if ([int]$open.n -ge $cap) {
  Write-Host ""
  Write-Host "★ 已經滿了。種下去他在 APP 裡就開不了新的心事——那是額度，不是 bug。" -ForegroundColor Yellow
  Write-Host "  要嘛先在 APP 裡把舊的結案，要嘛用 .\dev\yudie.ps1 -Plan zhiji 撥高上限。"
  $ans = Read-Host "還是要種？(yes/no)"
  if ($ans -ne 'yes') { Write-Host "取消。"; exit 0 }
}


# ── 讀種子 ─────────────────────────────────────────────────────────
$seedPath = Join-Path $PSScriptRoot "xinji-seed.json"
if (-not (Test-Path $seedPath)) {
  Write-Host "找不到 $seedPath。" -ForegroundColor Red
  exit 1
}
$seed = Get-Content -Path $seedPath -Raw -Encoding UTF8 | ConvertFrom-Json
$first = $seed | Where-Object { $_.seq -eq 1 }


# ── 開心事 ─────────────────────────────────────────────────────────
# question_norm 照 rules.ts 的作法留首卦問句：之後在 APP 裡問同一件事會自動歸線。
$title   = Q $first.question
$subject = Q "阿凱"
$cat     = Q "感情"
$norm    = Q ($first.question -replace '[，。！？、\s]', '')

$th = @(Invoke-Sql (
  "insert into threads (user_id, title, subject, category, question_norm, status, " +
  "opened_at, last_cast_at) values ($uid::uuid, $title, $subject, $cat, $norm, 'open', " +
  "now() - interval '56 days', now() - interval '1 day') returning id;"))[0]
$tid = Q $th.id
Write-Host ""
Write-Host "開了心事 $($th.id)" -ForegroundColor Cyan
Write-Host "  「$($first.question)」　對象 阿凱　類別 感情"


# ── 塞三卦 ─────────────────────────────────────────────────────────
# 應期：前兩卦刻意給過去的日子且不回評——那正是「觀喵來問你後來呢」的觸發條件。
$DUE = @{ 1 = 40; 2 = 5; 3 = -6 }   # 幾天前到期（負數＝還沒到）

foreach ($c in ($seed | Sort-Object seq)) {
  $chart = $c.chart | ConvertTo-Json -Depth 20 -Compress
  $lines = "ARRAY[" + (($c.chart.lines) -join ",") + "]::smallint[]"
  $bian  = if ($c.gua_bian) { Q $c.gua_bian } else { "null" }
  $ago   = [int]$c.days_ago
  $due   = [int]$DUE[[int]$c.seq]
  $dueSql = if ($due -ge 0) { "(current_date - $due)" } else { "(current_date + " + [Math]::Abs($due) + ")" }
  $reading = Q ($c.digest + "`n`n（測試用種子卦，非真實批文。）")

  Invoke-Sql (
    "insert into casts (user_id, character_id, channel, question, question_norm, " +
    "question_raw, question_source, category, lines, chart, gua_ben, gua_bian, palace, " +
    "reading, digest, due_date, yong_qin, yong_via_shi, thread_id, created_at) values (" +
    "$uid::uuid, " + (Q $c.character_id) + ", 'web', " + (Q $c.question) + ", " +
    (Q ($c.question -replace '[，。！？、\s]', '')) + ", " + (Q $c.question) + ", 'seed', " +
    "$cat, $lines, " + (Q $chart) + "::jsonb, " + (Q $c.gua_ben) + ", $bian, " +
    (Q $c.chart.palace) + ", $reading, " + (Q $c.digest) + ", $dueSql, '妻財', false, " +
    "$tid::uuid, now() - interval '$ago days');") | Out-Null

  $dueTxt = if ($due -ge 0) { "應期 $due 天前（未回評）" } else { "應期還沒到" }
  Write-Host "  ＋ $($ago) 天前　$($c.gua_ben)　$dueTxt"
}

Write-Host ""
Write-Host "✅ 種好了。打開 APP 的心跡 → 心事，應該看得到：" -ForegroundColor Green
Write-Host "   ・時間軸三個點，溫度線先下再回（妻財 休 → 囚 → 相）"
Write-Host "   ・兩張過了應期沒回評的卦 → 角色留言會來問後來呢"
Write-Host "   ・要收回：同一行指令加 -Undo"
