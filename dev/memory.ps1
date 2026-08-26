# dev/memory.ps1 — 清角色記憶（指定帳號，或全服）。
#
# 為什麼要有這支：改了 persona 之後，舊規則生成的內容會從記憶回灌進 context，
# 角色就會繼續用舊風格講話——看起來像「改了沒生效」。0017 那支 migration
# 當初就是為了這件事，但 migration 只能跑一次，這支是可以隨時再跑的版本。
#
# 【記憶存在三個地方，清一處不夠】
#   character_memories       0032 之後的長期記憶，一則一列（會被注入 context）
#   chat_messages            對話明細（最近幾輪當 few-shot 注入，且會再被彙整回長期記憶）
#   user_character.memory_summary   0032 之前的單段文字，欄位還在（沒刪，回滾才安全）
# 只清 chat_messages 的話，長期記憶會把舊風格再灌回來；只清長期記憶的話，
# 對話明細會在下次彙整時重新生出一份。所以三處一起清。
#
# 好感（favor）與道緣事件進度**不動**——那是他累積的東西，不該因為我們改 prompt 就歸零。
#
# 用法（Token 與 -ProjectRef 規則同 lingshi.ps1）：
#   .\dev\memory.ps1 -Email you@example.com                 # 只看：這人記得多少（預設，不動）
#   .\dev\memory.ps1 -Email you@example.com -Clear          # 清這個帳號的全部角色
#   .\dev\memory.ps1 -Email you@example.com -Clear -Char daoshi_m   # 只清大師兄
#   .\dev\memory.ps1 -AllUsers                              # 只看：全服統計
#   .\dev\memory.ps1 -AllUsers -Clear                       # 全服清空（要打全大寫確認）
#   .\dev\casts.ps1  -Find 六六                             # 忘了帳號：先找人

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,
  [string]$Find,
  [switch]$AllUsers,
  [switch]$Clear,
  [ValidateSet('daoshi_m','daoshi_f','lingshou')]
  [string]$Char,
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


$CHAR_NAME = @{ daoshi_m = '大師兄'; daoshi_f = '師妹'; lingshou = '觀貓' }

# ── 全服 ───────────────────────────────────────────────────────────
if ($AllUsers) {
  $s = @(Invoke-Sql (
    "select (select count(*) from character_memories) as mems, " +
    "(select count(*) from chat_messages) as msgs, " +
    "(select count(*) from user_character where memory_summary is not null) as legacy, " +
    "(select count(distinct user_id) from chat_messages) as people;"))[0]
  Write-Host ""
  Write-Host "全服記憶" -ForegroundColor Cyan
  Write-Host "  長期記憶 $($s.mems) 則"
  Write-Host "  對話明細 $($s.msgs) 則（$($s.people) 人）"
  Write-Host "  舊版 memory_summary $($s.legacy) 筆"

  if (-not $Clear) { Write-Host "`n（唯讀檢視。要清空加 -Clear）"; exit 0 }

  Write-Host ""
  Write-Host "★ 這會清掉全服所有人的角色記憶與對話明細，無法復原。" -ForegroundColor Red
  Write-Host "  好感與道緣事件進度不動。卦、靈石、心跡都不動。"
  $ans = Read-Host "確定的話，請打 CLEAR ALL（全大寫）"
  if ($ans -cne 'CLEAR ALL') { Write-Host "取消。"; exit 0 }

  Invoke-Sql "delete from character_memories;" | Out-Null
  Invoke-Sql "delete from chat_messages;" | Out-Null
  Invoke-Sql "update user_character set memory_summary = null where memory_summary is not null;" | Out-Null
  Write-Host "`n✅ 全服記憶已清空。" -ForegroundColor Green
  exit 0
}

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


# ── 這個帳號記得多少 ───────────────────────────────────────────────
$filter = if ($Char) { " and character_id = " + (Q $Char) } else { "" }
$per = @(Invoke-Sql (
  "select uc.character_id as cid, " +
  "(select count(*) from character_memories m where m.user_id = uc.user_id and m.character_id = uc.character_id) as mems, " +
  "(select count(*) from chat_messages c where c.user_id = uc.user_id and c.character_id = uc.character_id) as msgs, " +
  "(uc.memory_summary is not null) as legacy, uc.favor " +
  "from user_character uc where uc.user_id = " + (Q $t.id) + "::uuid" + $filter + " order by uc.character_id;"))

if (-not $per) { Write-Host "`n這個帳號還沒有跟任何角色說過話。" -ForegroundColor Yellow; exit 0 }
Write-Host ""
$per | ForEach-Object {
  [pscustomobject]@{
    角色 = $CHAR_NAME[$_.cid]
    長期記憶 = $_.mems
    對話明細 = $_.msgs
    舊摘要 = $(if ($_.legacy -eq $true -or $_.legacy -eq 'true') { "有" } else { "" })
    好感 = $_.favor
  }
} | Format-Table -AutoSize

if (-not $Clear) { Write-Host "（唯讀檢視。要清除加 -Clear）"; exit 0 }

$scope = if ($Char) { "$($CHAR_NAME[$Char]) 一位" } else { "全部三位角色" }
Write-Host ""
Write-Host "→ 清除這個帳號 $scope 的長期記憶、對話明細與舊摘要" -ForegroundColor Yellow
Write-Host "  好感不動（$(($per | ForEach-Object { "$($CHAR_NAME[$_.cid]) $($_.favor)" }) -join '、')）"
$ans = Read-Host "確認？(yes/no)"
if ($ans -ne 'yes') { Write-Host "取消。"; exit 0 }

$u = (Q $t.id) + "::uuid"
Invoke-Sql ("delete from character_memories where user_id = $u" + $filter + ";") | Out-Null
Invoke-Sql ("delete from chat_messages where user_id = $u" + $filter + ";") | Out-Null
Invoke-Sql ("update user_character set memory_summary = null where user_id = $u" + $filter + ";") | Out-Null
Write-Host "`n✅ 清好了。他下次開口，角色會像第一次見到他。" -ForegroundColor Green
