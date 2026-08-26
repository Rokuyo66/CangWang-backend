# dev/casts.ps1 — 看某個帳號最近問了什麼（唯讀，什麼都不動）。
#
# 用途：回報「解卦怪怪的」時，先看他實際問了什麼、抽到什麼卦、應期回評了沒。
# 不必開 Supabase 後台一張一張表點。
#
# 用法（Token 與 -ProjectRef 規則同 lingshi.ps1）：
#   .\dev\casts.ps1 -Email you@example.com              # 最近 15 卦
#   .\dev\casts.ps1 -Email you@example.com -N 40        # 最近 40 卦
#   .\dev\casts.ps1 -TgId 8674594142 -Full              # 連批文正文一起印（很長）
#   .\dev\casts.ps1 -Email you@example.com -Fortune     # 連每日運勢卦一起列（預設不列）
#   .\dev\casts.ps1 -Find 六六                          # 忘了帳號：先找人

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,
  [string]$Find,
  [int]$N = 15,
  [switch]$Full,
  [switch]$Fortune,
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
# ⚠ 這一段（token 檢查／Invoke-Sql／Q／找人）與 lingshi.ps1、yudie.ps1 是同一份。
#   刻意複製而不抽成共用檔：這幾支是給非工程師在公司機上單獨執行的，
#   多一個 dot-source 的相對路徑就多一種「在他那台跑不起來」的方式，
#   而那種錯誤我沒辦法在這裡重現。改任何一支的這一段，記得四支一起改。

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

# 兩段式：先解 profile id 再撈完整身分。一段式會被自己的 where 咬到
# （用 -TgId 指定時 where 濾掉了 web 那列，聚合出來的 email 就是空的）。
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
$who = if ($t.display_name) { $t.display_name } else { "(無暱稱)" }
if ($t.email) { $who += "　$($t.email)" }
if ($t.tg_id) { $who += "　tg:$($t.tg_id)" }
Write-Host ""
Write-Host "帳號 $($t.id)" -ForegroundColor Cyan
Write-Host "     $who"


# ── 近期問卦 ───────────────────────────────────────────────────────
# 日運卦預設不列：它每天一張，會把真正的問事卦擠到看不見。
$noFortune = if ($Fortune) { "" } else { "and coalesce(c.category,'') <> '日運' " }
$sql =
  "select to_char(c.created_at at time zone 'Asia/Taipei','MM-DD HH24:MI') as at, " +
  "coalesce(c.category,'-') as cat, c.gua_ben as gua, c.gua_bian as bian, " +
  "coalesce(c.character_id,'-') as who, c.question, c.digest, " +
  "coalesce(c.yong_qin, case when c.yong_via_shi then '世爻' else '' end) as yong, " +
  "to_char(c.due_date,'MM-DD') as due, f.verdict, " +
  "t.title as thread " +
  "from casts c " +
  "left join feedback f on f.cast_id = c.id " +
  "left join threads t on t.id = c.thread_id " +
  "where c.user_id = " + (Q $t.id) + "::uuid " + $noFortune +
  "order by c.created_at desc limit $N;"
$rows = @(Invoke-Sql $sql)

if (-not $rows) { Write-Host "`n這個帳號還沒有問卦紀錄。" -ForegroundColor Yellow; exit 0 }

$V = @{ 1 = "應驗"; 2 = "部分"; 3 = "未應"; 0 = "未發生" }
Write-Host ""
Write-Host "近 $($rows.Count) 卦（新→舊，台北時間）"
$rows | ForEach-Object {
  [pscustomobject]@{
    時間 = $_.at
    類 = $_.cat
    卦 = $(if ($_.bian) { "$($_.gua)→$($_.bian)" } else { $_.gua })
    用神 = $_.yong
    問 = $(if ($_.question.Length -gt 22) { $_.question.Substring(0,22) + "…" } else { $_.question })
    應期 = $_.due
    回評 = $(if ($null -ne $_.verdict) { $V[[int]$_.verdict] } else { "" })
    心事 = $_.thread
  }
} | Format-Table -AutoSize

if ($Full) {
  Write-Host ""
  Write-Host "── 批文正文 ──" -ForegroundColor Cyan
  $full = @(Invoke-Sql (
    "select to_char(c.created_at at time zone 'Asia/Taipei','MM-DD HH24:MI') as at, " +
    "c.question, c.reading from casts c where c.user_id = " + (Q $t.id) + "::uuid " +
    $noFortune + "order by c.created_at desc limit $N;"))
  foreach ($r in $full) {
    Write-Host ""
    Write-Host "【$($r.at)】$($r.question)" -ForegroundColor Yellow
    Write-Host $r.reading
  }
}

# ── 一眼看得出的統計 ───────────────────────────────────────────────
$stat = @(Invoke-Sql (
  "select count(*) filter (where coalesce(category,'') <> '日運') as casts, " +
  "count(*) filter (where category = '日運') as fortune, " +
  "count(*) filter (where due_date is not null) as due_total " +
  "from casts where user_id = " + (Q $t.id) + "::uuid;"))[0]
$vd = @(Invoke-Sql (
  "select count(*) filter (where f.verdict = 1) as hit, " +
  "count(*) filter (where f.verdict = 2) as part, " +
  "count(*) filter (where f.verdict = 3) as miss " +
  "from feedback f where f.user_id = " + (Q $t.id) + "::uuid;"))[0]
Write-Host ""
Write-Host "總計　問事 $($stat.casts) 卦・日運 $($stat.fortune) 次・給過應期 $($stat.due_total)" -ForegroundColor DarkGray
Write-Host "回評　應驗 $($vd.hit)・部分 $($vd.part)・未應 $($vd.miss)" -ForegroundColor DarkGray
