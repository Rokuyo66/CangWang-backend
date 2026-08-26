# dev/yudie.ps1 — 指定帳號開關玉牒（訂閱），測試用。金流還沒接，這是唯一的開關。
#
# 為什麼需要這支：profiles.plan 全站沒有任何一行程式會寫（0030 只加了欄位，
# 金流沒接），所以線上每一個帳號永遠是 free。要驗「持牒與不持牒差在哪」，
# 只能從資料庫這一側手動撥。
#
# 到期一律看 plan_until，不另存狀態（services.ts planOf）：
#   plan_until 為 null  → 無期限
#   plan_until 已過     → 視同 free，且**欄位不會被改回 free**
# 最後那條很重要：資料庫裡寫著 cangwang 但已過期的帳號，行為上就是 free。
# 所以 -Expire 測的是「過期」這條路徑，跟 -Off 把它抹掉不是同一件事。
#
# 用法（Token 與 -ProjectRef 規則同 lingshi.ps1）：
#   .\dev\yudie.ps1 -Email you@example.com                      # 只看：目前方案與各項額度（預設，什麼都不動）
#   .\dev\yudie.ps1 -Find 六六                                  # 忘了帳號：用暱稱/信箱片段找人
#   .\dev\yudie.ps1 -Email you@example.com -Plan zhiji          # 開知幾，無期限
#   .\dev\yudie.ps1 -Email you@example.com -Plan cangwang -Days 30
#   .\dev\yudie.ps1 -TgId 8674594142 -Expire                    # 保留方案名，把期限撥到一分鐘前（測到期）
#   .\dev\yudie.ps1 -Email you@example.com -Off                 # 收牒：改回 free、清掉期限
#
# 三種指定帳號的方式（Email／TgId／UserId）擇一，同 lingshi.ps1。

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,
  [string]$Find,
  [ValidateSet('free','guanwei','zhiji','cangwang')]
  [string]$Plan,                         # 要開哪一階
  [int]$Days = 0,                        # 幾天後到期（0＝無期限）
  [switch]$Expire,                       # 把期限撥到過去，測「到期即視同 free」
  [switch]$Off,                          # 收牒：plan=free、plan_until=null
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
  Write-Host '換成你自己那串：$env:SUPABASE_ACCESS_TOKEN = "sbp_……"'
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

# SQL 一律字串相接，整支不用 here-string——Windows PowerShell 5.1 的解析器對它挑剔，
# PowerShell 7 能過的它未必吃。同 lingshi.ps1。

$IDENT_VIEW =
  "select pr.id, pr.display_name, pr.dao_name, pr.lingshi, pr.plan, " +
  "to_char(pr.plan_until at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') as until_tpe, " +
  "(pr.plan_until is not null and pr.plan_until < now()) as expired, " +
  "max(case when i.provider = 'web' then u.email end) as email, " +
  "max(case when i.provider = 'tg' then i.external_id end) as tg_id " +
  "from profiles pr " +
  "left join identities i on i.user_id = pr.id " +
  "left join auth.users u on i.provider = 'web' and u.id::text = i.external_id "

# 各方案的額度表。數字來源逐項對齊程式，改程式要記得改這裡——
# 這張表的用途是「開牒之後該去看哪裡不一樣」，寫錯了會讓人測錯地方。
#   起卦／追問  services.ts PLAN_CASTS / PLAN_FOLLOWUPS
#   閒聊／共憶／注入輪數／釘選  chat.ts PLAN_CHATS / PLAN_MEMORIES / PLAN_TURNS / PLAN_PINS
#   心跡在記   xinji.ts PLAN_THREADS
#   語音收藏   voice.ts PLAN_CLIPS
#   卦案存檔   case-run.ts keptQuota
$PLAN_LABEL = @{ free = '無牒（free）'; guanwei = '觀微'; zhiji = '知幾'; cangwang = '藏往' }
$QUOTAS = @(
  @{ n = '每日免費起卦'; free = 2; guanwei = 3;  zhiji = 5;  cangwang = 8   },
  @{ n = '每日免費追問'; free = 2; guanwei = 3;  zhiji = 8;  cangwang = 20  },
  @{ n = '每日免費閒聊'; free = 8; guanwei = 20; zhiji = 50; cangwang = 100 },
  @{ n = '共憶注入則數'; free = 6; guanwei = 12; zhiji = 24; cangwang = 40  },
  @{ n = '注入對話輪數'; free = 6; guanwei = 8;  zhiji = 12; cangwang = 16  },
  @{ n = '可釘選回憶'  ; free = 0; guanwei = 1;  zhiji = 3;  cangwang = 5   },
  @{ n = '心跡同時在記'; free = 1; guanwei = 3;  zhiji = 8;  cangwang = 20  },
  @{ n = '語音收藏段數'; free = 3; guanwei = 10; zhiji = 30; cangwang = 100 },
  @{ n = '每月朗讀字數'; free = 5000; guanwei = 12000; zhiji = 30000; cangwang = 60000 },
  @{ n = '卦案記憶檔案'; free = 1; guanwei = 3;  zhiji = 3;  cangwang = 3   }
)

# ── 找人 ───────────────────────────────────────────────────────────
if ($Find) {
  $k = Q "%$Find%"
  $rows = Invoke-Sql ($IDENT_VIEW +
    "where pr.display_name ilike $k or pr.dao_name ilike $k " +
    "or u.email ilike $k or (i.provider = 'tg' and i.external_id ilike $k) " +
    "group by pr.id order by pr.created_at desc limit 20;")
  if (-not $rows) { Write-Host "找不到符合「$Find」的帳號。" -ForegroundColor Yellow; exit 1 }
  $rows | Format-Table id, display_name, email, tg_id, plan, until_tpe -AutoSize
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

# 兩段式：先解 profile id 再撈完整身分。一段式會被自己的 where 咬到（同 lingshi.ps1）。
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
  $hit | Format-Table id, display_name, email, tg_id, plan -AutoSize
  exit 1
}
$t = $hit[0]

# 「資料庫寫什麼」與「程式當它是什麼」是兩件事：過期了欄位不會改回 free。
$dbPlan  = if ($t.plan) { "$($t.plan)" } else { 'free' }
$effective = if ($t.expired) { 'free' } else { $dbPlan }

$nick = if ($t.display_name) { $t.display_name } else { "(無暱稱)" }
$who  = $nick
if ($t.email) { $who += "　$($t.email)" }
if ($t.tg_id) { $who += "　tg:$($t.tg_id)" }
Write-Host ""
Write-Host "帳號 $($t.id)" -ForegroundColor Cyan
Write-Host "     $who"
Write-Host "     靈石 $($t.lingshi)"
Write-Host ""
Write-Host "資料庫寫著 $dbPlan" -NoNewline
if ($t.until_tpe) { Write-Host "，期限 $($t.until_tpe)" -NoNewline } else { Write-Host "，無期限" -NoNewline }
Write-Host ""
if ($t.expired) {
  Write-Host "程式當它是 free（已過期）" -ForegroundColor Yellow
  Write-Host "  ↑ 過期不會把欄位改回 free，這是刻意的：到期一律看 plan_until，不另存狀態。"
} else {
  $c = if ($effective -eq 'free') { 'Gray' } else { 'Green' }
  Write-Host "程式當它是 $effective（$($PLAN_LABEL[$effective])）" -ForegroundColor $c
}

# ── 決定要做什麼 ───────────────────────────────────────────────────
$acts = @()
if ($Plan)   { $acts += 'Plan' }
if ($Expire) { $acts += 'Expire' }
if ($Off)    { $acts += 'Off' }
if ($acts.Count -gt 1) {
  Write-Host "`n-Plan / -Expire / -Off 只能給一個。" -ForegroundColor Red
  exit 1
}

if ($acts.Count -eq 0) {
  # ── 唯讀：把「開牒之後差在哪」整張攤開，省得每次去翻程式 ──────────
  Write-Host ""
  Write-Host "各方案額度（目前這個帳號吃的是 $effective 那一欄）"
  $rows = foreach ($q in $QUOTAS) {
    [pscustomobject]@{
      '項目'   = $q.n
      '無牒'   = $q.free
      '觀微'   = $q.guanwei
      '知幾'   = $q.zhiji
      '藏往'   = $q.cangwang
    }
  }
  $rows | Format-Table -AutoSize

  # 朗讀額度是唯一「按月結算、會累積」的一項，所以另外把現況查出來——
  # 光看上表只知道上限，看不出這個帳號現在還剩多少，而回報「語音載不下來」
  # 時要看的正是這個數字。
  $ym = (Get-Date).ToUniversalTime().AddHours(8).ToString('yyyy-MM')
  $m1 = Q "$ym-01"
  # 一行寫完：PowerShell 的續行是反引號不是反斜線，而反斜線在這裡會被
  # 當成字面字元吃進 SQL 裡，錯得很難看出來。
  $q = "select coalesce(sum(chars), 0) as used from tts_usage where user_id = " + (Q $t.id) + "::uuid and day >= $m1::date and day < ($m1::date + interval '1 month');"
  $tts = @(Invoke-Sql $q)[0]
  $ttsCaps = @{ free = 5000; guanwei = 12000; zhiji = 30000; cangwang = 60000 }
  $ttsMax  = $ttsCaps[[string]$effective]
  if (-not $ttsMax) { $ttsMax = 5000 }
  $ttsUsed = [int]$tts.used
  $ttsLeft = [Math]::Max(0, $ttsMax - $ttsUsed)
  $ttsSegs = [Math]::Floor($ttsLeft / 1300)
  Write-Host ""
  Write-Host "本月朗讀（$ym 台北）　已用 $ttsUsed ／ $ttsMax 字　還剩 $ttsLeft 字（約 $ttsSegs 段）"
  if ($ttsLeft -eq 0) {
    Write-Host "  ⚠ 額度用完了，朗讀會被擋下。下個月一號重新計算。" -ForegroundColor Yellow
  }

  Write-Host "另外三項不是數字，是有無："
  Write-Host "  · 月誌卷首語   無牒鎖著（只給統計）／持牒每月生成一次"
  Write-Host "  · 全站日熔斷   只擋 free；持牒者不受 DAILY_GLOBAL_CAP 影響"
  Write-Host "  · 貼紙付費包   與方案無關，是靈石另外買的（dev\lingshi.ps1）"
  Write-Host ""
  Write-Host "（唯讀檢視。要撥用 -Plan zhiji ／ -Expire ／ -Off）"
  exit 0
}

# ── 動手 ───────────────────────────────────────────────────────────
if ($Off) {
  $sql = "update profiles set plan = 'free', plan_until = null where id = " + (Q $t.id) + "::uuid;"
  $desc = "收牒 → free，清掉期限"
} elseif ($Expire) {
  if ($dbPlan -eq 'free') {
    Write-Host "`n這個帳號本來就是 free，沒有牒可以過期。先 -Plan zhiji 開一張。" -ForegroundColor Yellow
    exit 1
  }
  # 撥到一分鐘前而不是「現在」：planOf 是 < now() 才算過期，設成現在會卡在邊界上
  $sql = "update profiles set plan_until = now() - interval '1 minute' where id = " + (Q $t.id) + "::uuid;"
  $desc = "把 $dbPlan 的期限撥到一分鐘前（方案名保留，行為變 free）"
} else {
  if ($Plan -eq 'free') {
    $sql = "update profiles set plan = 'free', plan_until = null where id = " + (Q $t.id) + "::uuid;"
    $desc = "設為 free，清掉期限"
  } elseif ($Days -gt 0) {
    $sql = "update profiles set plan = " + (Q $Plan) + ", plan_until = now() + interval '$Days days' where id = " + (Q $t.id) + "::uuid;"
    $desc = "開 $($PLAN_LABEL[$Plan])，$Days 天後到期"
  } else {
    $sql = "update profiles set plan = " + (Q $Plan) + ", plan_until = null where id = " + (Q $t.id) + "::uuid;"
    $desc = "開 $($PLAN_LABEL[$Plan])，無期限"
  }
}

Write-Host ""
Write-Host "→ $desc" -ForegroundColor Yellow
Invoke-Sql $sql | Out-Null

# 整串先組好再傳。PowerShell 在命令呼叫模式下，+ 會被當成「下一個參數」而不是
# 字串相接運算子——寫成 Invoke-Sql "a" + $b + "c" 會拿 a、+、$b、+、c 五個引數去打
# 只收一個參數的函式，然後在你最不想除錯的地方炸掉。lingshi.ps1 一律加括號，同此。
$q = "$IDENT_VIEW where pr.id = " + (Q $t.id) + "::uuid group by pr.id;"
$after = @(Invoke-Sql $q)[0]
$afterPlan = if ($after.plan) { "$($after.plan)" } else { 'free' }
$afterEff  = if ($after.expired) { 'free' } else { $afterPlan }
Write-Host "  ✅ 資料庫 $afterPlan" -NoNewline -ForegroundColor Green
if ($after.until_tpe) { Write-Host "　期限 $($after.until_tpe)" -NoNewline -ForegroundColor Green } else { Write-Host "　無期限" -NoNewline -ForegroundColor Green }
Write-Host ""
Write-Host "     程式當它是 $afterEff（$($PLAN_LABEL[$afterEff])）" -ForegroundColor Green

Write-Host ""
Write-Host "App 那邊要重新拉一次 profile 才會變——殺掉重開，或切到別的分頁再切回來。" -ForegroundColor DarkGray
Write-Host "看得出差別的地方：起卦鈕的「免費剩 N 卦」、心跡在記的格數、月誌有沒有卷首語、語音收藏上限。" -ForegroundColor DarkGray
