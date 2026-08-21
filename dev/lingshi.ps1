# dev/lingshi.ps1 — 指定帳號調靈石（測試用），走 Supabase Management API。
#
# 為什麼不是直接 update profiles.lingshi：餘額的真相在 ledger，profiles.lingshi 只是快取。
# 手改快取，帳就從此對不起來（/stats 的「發放／消耗」永遠少這一筆）。
# 這支一律走 apply_lingshi()，餘額與流水一起動，動作記成 admin_grant，事後看得出是後台發的。
#
# 用法（Token 與 -ProjectRef 規則同 migrate.ps1）：
#   .\dev\lingshi.ps1 -Email you@example.com                 # 只看：餘額＋近期流水（預設，什麼都不動）
#   .\dev\lingshi.ps1 -TgId 8674594142                       # 同上，用 TG 帳號指定
#   .\dev\lingshi.ps1 -Find 六六                             # 忘了帳號：用暱稱/信箱片段找人
#   .\dev\lingshi.ps1 -Email you@example.com -Amount 500     # 加 500 顆
#   .\dev\lingshi.ps1 -Email you@example.com -Amount -500    # 扣回 500 顆（扣到負數會被 DB 擋下）
#   .\dev\lingshi.ps1 -TgId 8674594142 -Set 0                # 歸零：測「靈石不足」的檔法
#
# 三種指定帳號的方式（Email／TgId／UserId）擇一。Email 是網頁登入的信箱（auth.users），
# TgId 是 Telegram 的純數字 id（在 bot 裡對自己下 /stats 那個身分）。

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,                       # profiles.id（uuid），前兩者查出來的那個
  [string]$Find,                         # 找人：比對暱稱、道號、信箱、tg id 的片段
  [int]$Amount = 0,                      # 增減量（負數＝扣）
  [int]$Set = -1,                        # 設成指定餘額（0 也可；-1＝不使用本參數）
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

# 佔位字串照抄很常見（說明裡寫 sbp_... 就真的貼了 sbp_...），
# 讓它在這裡停，比讓 API 回一句 JWT could not be decoded 好懂。
if ($Token -match '^\s*sbp_\.+\s*$') {
  Write-Host "token 還是佔位字串（$Token）。" -ForegroundColor Red
  Write-Host '換成你自己那串：$env:SUPABASE_ACCESS_TOKEN = "sbp_……"'
  exit 1
}
if ($Token -notmatch '^sbp_') {
  Write-Host "這不像 Management API token——它是 sbp_ 開頭的那串。" -ForegroundColor Red
  Write-Host "（anon / service_role key 是 eyJ 開頭的 JWT，那兩把在這裡不能用。）"
  Write-Host "拿法：supabase.com → Account → Access Tokens"
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
    # 這句是 token 的問題，不是 SQL 的問題——照字面去查 SQL 會查錯方向
    if ($detail -match 'JWT could not be decoded|Unauthorized|Invalid authentication') {
      throw "Token 不被接受（$detail）。要的是 supabase.com → Account → Access Tokens 那把 sbp_ 開頭的整串。"
    }
    throw "SQL 失敗：$detail"
  }
}

# SQL 字面值：單引號成雙，不讓暱稱裡的 ' 把語句掰開
function Q { param([string]$s) "'" + ($s -replace "'", "''") + "'" }

# SQL 一律用字串相接組，整支不用 here-string。
# Windows PowerShell 5.1 的解析器對 here-string 挑剔得多，PowerShell 7 能過的它未必吃；
# 這支就是要在 5.1 上跑，少一個會炸的語法就少一次「拉下來卻跑不動」。

# 一個 profile 可能同時綁 tg 與 web，聚合成一列，才不會同一個人出現兩次
$IDENT_VIEW =
  "select pr.id, pr.display_name, pr.dao_name, pr.lingshi, " +
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
  $rows | Format-Table id, display_name, dao_name, email, tg_id, lingshi -AutoSize
  Write-Host "挑一個，再用 -UserId / -Email / -TgId 指定。"
  exit 0
}

# ── 指定帳號 ───────────────────────────────────────────────────────
$given = @($Email, $TgId, $UserId) | Where-Object { $_ }
if ($given.Count -eq 0) {
  Write-Host "要指定帳號：-Email / -TgId / -UserId 擇一（或先 -Find 關鍵字 找人）。" -ForegroundColor Red
  exit 1
}
if ($given.Count -gt 1) {
  Write-Host "-Email / -TgId / -UserId 只能給一個。" -ForegroundColor Red
  exit 1
}

if     ($UserId) { $where = "pr.id = " + (Q $UserId) + "::uuid" }
elseif ($Email)  { $where = "u.email = " + (Q $Email) }
else             { $where = "i.provider = 'tg' and i.external_id = " + (Q $TgId) }

# 兩段式：先用條件解出 profile id，再用 id 撈完整身分。
# 一段式會被自己的 where 咬到——用 -TgId 指定時，where 濾掉了 web 那列，
# 聚合出來的 email 就是空的，畫面上看起來像「這人沒綁網頁」。
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
  Write-Host "指定條件命中 $($hit.Count) 個帳號，改用 -UserId 指定其中一個：" -ForegroundColor Yellow
  $hit | Format-Table id, display_name, email, tg_id, lingshi -AutoSize
  exit 1
}
$t = $hit[0]
$nick = if ($t.display_name) { $t.display_name } else { "(無暱稱)" }
$who  = $nick
if ($t.email) { $who += "　$($t.email)" }
if ($t.tg_id) { $who += "　tg:$($t.tg_id)" }
Write-Host ""
Write-Host "帳號 $($t.id)" -ForegroundColor Cyan
Write-Host "     $who"
Write-Host "目前靈石 $($t.lingshi)"

# ── 算增減量 ───────────────────────────────────────────────────────
$delta = $Amount
if ($Set -ge 0) {
  if ($Amount -ne 0) { Write-Host "`n-Amount 與 -Set 只能給一個。" -ForegroundColor Red; exit 1 }
  $delta = $Set - [int]$t.lingshi
  if ($delta -eq 0) { Write-Host "`n已經是 $Set，不用動。" -ForegroundColor Green; exit 0 }
}

# ── 動手 ───────────────────────────────────────────────────────────
if ($delta -ne 0) {
  $sign = if ($delta -gt 0) { "+$delta" } else { "$delta" }
  Write-Host "`n→ apply_lingshi(admin_grant, $sign)" -ForegroundColor Yellow
  try {
    $res = @(Invoke-Sql ("select apply_lingshi(" + (Q $t.id) + "::uuid, 'admin_grant', $delta) as balance;"))
    Write-Host "  ✅ 餘額 $($res[0].balance)" -ForegroundColor Green
  } catch {
    # 餘額扣成負數會被 apply_lingshi 自己 raise 掉（整筆回滾，流水也不會留）
    if ("$_" -match 'INSUFFICIENT_LINGSHI') {
      Write-Host "  ❌ 扣太多了：只有 $($t.lingshi) 顆，餘額不能為負。要歸零用 -Set 0。" -ForegroundColor Red
      exit 1
    }
    throw
  }
} else {
  Write-Host "`n（唯讀檢視。要調整加 -Amount N 或 -Set N）"
}

# ── 近期流水：這筆發下去有沒有落帳，看這裡 ─────────────────────────
$led = Invoke-Sql (
  "select action, amount, " +
  "to_char(created_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI') as at " +
  "from ledger where user_id = " + (Q $t.id) + "::uuid " +
  "order by created_at desc limit 8;")
if ($led) {
  Write-Host ""
  Write-Host "近期流水（台北時間）"
  $led | Format-Table at, action, amount -AutoSize
}
