# dev/engine-ab.ps1 — CLAUDE vs KIMI：拿「有應期回報」的卦，比準確度與成本（唯讀，什麼都不動）。
#
# 為什麼需要這支：解卦引擎在某個時點從 Claude 換成 KIMI（換的是環境變數
# INTERPRET_MODEL_CAST／INTERPRET_FORCE_MODEL，不在程式碼裡，所以 git log 查不到切換日）。
# 「哪個模型該當主力」不能靠印象，只有兩種證據能回答：
#   準確度 → casts.model（實際用到的模型）× feedback.verdict（用戶自己回報的應驗與否）
#   成本   → ai_usage 的四欄 token × model_prices 的單價
# 這支把兩邊擺在同一張表上。
#
# 【三個必須先知道的資料性質，否則會讀錯報表】
#
# 一、引擎歸屬是準的。casts.model 寫的是 services.ts 的 usedModel——主模型掛掉換家
#     重打之後的那一個。所以「掛在 Claude 名下的卦」確實是 Claude 解的，備援不會混進來。
#
# 二、分母天然乾淨。pipeline.ts 只在模型給了應期（ai.due）時才建 feedback 列，
#     所以「有應期回報」＝ feedback.verdict in (1,2,3)，不含日運卦、不含無應期的卦。
#     另外 verdict 只可能是 1/2/3（interpret 的 review 端點擋掉其他值），0 是舊語彙、實務上沒有。
#
# 三、成本不能逐卦歸戶。ai_usage 沒有 cast_id，只有 user_id + created_at。硬做時間窗
#     對齊會把追問與展開錯配到別卦上，寧可不做——本報表的成本一律按「引擎 × mode」
#     整段彙總，再除以該引擎的卦數。因為兩個引擎本來就分屬不同時段，這樣分得開。
#     ⚠ 也因此，casts.tokens_in 不要拿來算 Claude 成本：那一欄不含快取讀寫
#       （services.ts 的 usage.in 只有未命中部分），照它算會低估。成本一律讀 ai_usage。
#
# 【KIMI 的單價是參數，不是資料】
#   0043 刻意沒把 kimi 填進 model_prices（「填一個猜的數字比空著更糟」），這支沿用那個態度：
#   KIMI 單價由 -KimiIn / -KimiOut / -KimiCacheRead 帶進來，報表抬頭會把用到的數字印出來。
#   預設值取國際版 platform.kimi.ai 的公開報價，但**以你 Moonshot 後台的實際帳單為準**——
#   對完帳之後，正確做法是往 model_prices 插一列（改價＝update 一列，不必出 migration）：
#     insert into model_prices (model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out, note)
#     values ('kimi-k2.6', ?, ?, ?, ?, '取自 Moonshot 帳單 YYYY-MM')
#     on conflict (model_prefix) do update set usd_in = excluded.usd_in, usd_out = excluded.usd_out;
#   插進去之後，ai_cost() 的 unpriced 名單也會跟著乾淨，這支就不必再帶 -Kimi* 參數。
#
# 用法（Token 與 -ProjectRef 規則同 lingshi.ps1）：
#   .\dev\engine-ab.ps1                                   # 全站、全部歷史
#   .\dev\engine-ab.ps1 -Days 60                          # 只看近 60 天
#   .\dev\engine-ab.ps1 -Notes                            # 附上回評評語（未應的先列，最有料）
#   .\dev\engine-ab.ps1 -Email you@example.com            # 只看某個帳號（自己測的卦）
#   .\dev\engine-ab.ps1 -KimiIn 0.56 -KimiOut 3.39        # 換一組 KIMI 單價重算
#   .\dev\engine-ab.ps1 -Sql                              # 只印 SQL 不執行（貼進 Supabase SQL Editor 用）

[CmdletBinding()]
param(
  [string]$Email,
  [string]$TgId,
  [string]$UserId,
  [string]$Find,
  [int]$Days = 0,                        # 0 ＝ 全部歷史
  [switch]$Notes,                        # 附回評評語
  [int]$NoteN = 20,                      # 評語列幾則
  [switch]$Sql,                          # 只印 SQL
  [switch]$Raw,                          # 診斷用：印出第一支查詢的原始回應就停
  [decimal]$Twd = 32,                    # 美元兌台幣
  # KIMI 單價（美元／百萬 token）。見上方說明：這是參數不是事實，對帳後請改成你的實際數字。
  [decimal]$KimiIn = 0.95,
  [decimal]$KimiOut = 4.00,
  [decimal]$KimiCacheRead = 0.15,        # 目前程式沒收 cached_tokens，這欄實務上乘到的是 0
  [string]$Token = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef = "ajogafvzlhqwlxwkfcpn"
)

$ErrorActionPreference = 'Stop'

if (-not $Sql) {
  if (-not $Token) {
    Write-Host "找不到 Management API token。" -ForegroundColor Red
    Write-Host '設定方式：$env:SUPABASE_ACCESS_TOKEN = "sbp_你自己那串"（本 session 有效）'
    Write-Host '取得方式：supabase.com → Account → Access Tokens'
    Write-Host '（不想開 token 就加 -Sql，把查詢印出來貼進 Supabase SQL Editor。）'
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
  # 前綴重複：貼上時前面又自己打了一次 sbp_。API 只會回 401，訊息裡看不出是這個原因，
  # 而 401 會讓人去懷疑權限、去重發 token——先在這裡講清楚，省掉那一圈。
  if ($Token -match '^sbp_sbp_') {
    Write-Host "token 的 sbp_ 前綴重複了（$($Token.Substring(0, [math]::Min(12, $Token.Length)))…）。" -ForegroundColor Red
    Write-Host "整串只該有一個 sbp_ 開頭，把多的那個刪掉。"
    exit 1
  }
}

if ($Sql -and ($Email -or $TgId -or $Find)) {
  Write-Host "-Sql 只印查詢、不連線，所以查不了帳號。要限定帳號請直接給 -UserId（profiles.id）。" -ForegroundColor Red
  exit 1
}

# ── 回應正規化 ────────────────────────────────────────────────────
# Management API 的回應形狀不是永遠一樣：一般是「每列一個物件」的陣列，
# 但實測也遇過整包變成「單一物件、每個欄位是一條等長陣列」（欄式）的回法。
# 欄式若不轉回列，症狀不是報錯而是**每一列都印出同一組數字**——那比報錯危險，
# 因為它看起來像一份正常的報表。這支專門把任何一種形狀收斂回「一列一個物件」。
function ConvertTo-Rows {
  param($Data)
  if ($null -eq $Data) { return @() }

  # 包裝層：{ result: [...] } / { data: [...] } / { rows: [...] }
  if ($Data -is [psobject] -and $Data -isnot [object[]]) {
    foreach ($k in @('result', 'data', 'rows')) {
      $p = $Data.PSObject.Properties[$k]
      if ($p -and $null -ne $p.Value) { return (ConvertTo-Rows $p.Value) }
    }
  }

  $arr = @($Data)
  if ($arr.Count -eq 0) { return @() }

  # 欄式 → 列式。判定條件抓緊一點：單一物件、且**每一個**欄位都是等長陣列。
  # 本腳本的查詢沒有任何一欄回傳陣列，所以不會誤判到正常的單列結果。
  if ($arr.Count -eq 1 -and $arr[0] -is [psobject]) {
    $props = @($arr[0].PSObject.Properties)
    if ($props.Count -gt 0) {
      $allArrays = -not ($props | Where-Object { $_.Value -isnot [array] })
      if ($allArrays) {
        $n = @($props[0].Value).Count
        $sameLen = -not ($props | Where-Object { @($_.Value).Count -ne $n })
        if ($sameLen -and $n -ge 1) {
          return @(0..($n - 1) | ForEach-Object {
            $i = $_
            $o = [ordered]@{}
            foreach ($p in $props) { $o[$p.Name] = @($p.Value)[$i] }
            [pscustomobject]$o
          })
        }
      }
    }
  }

  # 列式：單值陣列攤平（有些回法會把純量包成一元陣列）
  return @($arr | ForEach-Object {
    $row = $_
    if ($row -isnot [psobject]) { return $row }
    $o = [ordered]@{}
    foreach ($p in $row.PSObject.Properties) {
      $v = $p.Value
      if ($v -is [array] -and @($v).Count -eq 1) { $v = @($v)[0] }
      $o[$p.Name] = $v
    }
    [pscustomobject]$o
  })
}

function Invoke-Sql {
  param([string]$Query)
  $body = @{ query = $Query } | ConvertTo-Json -Depth 3 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  try {
    # 用 Invoke-WebRequest 拿原始文字再自己 ConvertFrom-Json：
    # 這樣 -Raw 診斷看得到真實回應，反序列化的行為也不隨 PowerShell 版本飄。
    $resp = Invoke-WebRequest -Method Post `
      -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
      -Headers @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' } `
      -Body $bytes
    $text = $resp.Content
    if ($Raw) {
      Write-Host ""
      Write-Host "── 原始回應（前 1200 字）──" -ForegroundColor Cyan
      Write-Host $text.Substring(0, [math]::Min(1200, $text.Length))
      Write-Host ""
      Write-Host "（-Raw 只印形狀，不含 token。把這段貼回來就能對症下藥。）" -ForegroundColor DarkGray
      exit 0
    }
    return (ConvertTo-Rows ($text | ConvertFrom-Json))
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

# 每一處 Format-Table 都帶 -Property *：不帶的話它只印前 10 個屬性，
# 而且**不報錯、多的欄位直接消失**。主表有 12 欄，被吃掉的正好是加權分與信賴區間——
# 那是整份報表最不能漏的兩欄，漏了還看不出來漏了。

# SQL 一律字串相接，整支不用 here-string——Windows PowerShell 5.1 的解析器對它挑剔。
# ⚠ 這一段（token 檢查／Invoke-Sql／Q／找人）與 lingshi.ps1、casts.ps1、yudie.ps1 是同一份。
#   刻意複製而不抽成共用檔，理由見 casts.ps1。改任何一支的這一段，記得五支一起改。

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


# ── 可選：限定帳號 ─────────────────────────────────────────────────
# 不給就是全站。全站是預設，因為要決定的是「主力模型」，不是「某個人的卦」。
$scopeId = $null
$given = @($Email, $TgId, $UserId) | Where-Object { $_ }
if ($given.Count -gt 1) { Write-Host "-Email / -TgId / -UserId 只能給一個。" -ForegroundColor Red; exit 1 }
if ($given.Count -eq 1 -and $Sql) {
  # -Sql 不連線，UserId 直接當成 profiles.id 用（其餘指定方式在上面就擋掉了）
  $scopeId = $UserId
}
elseif ($given.Count -eq 1) {
  if     ($UserId) { $where = "pr.id = " + (Q $UserId) + "::uuid" }
  elseif ($Email)  { $where = "u.email = " + (Q $Email) }
  else             { $where = "i.provider = 'tg' and i.external_id = " + (Q $TgId) }
  $ids = @(Invoke-Sql (
    "select distinct pr.id from profiles pr " +
    "left join identities i on i.user_id = pr.id " +
    "left join auth.users u on i.provider = 'web' and u.id::text = i.external_id " +
    "where $where;"))
  if ($ids.Count -eq 0) { Write-Host "查無此帳號。" -ForegroundColor Yellow; exit 1 }
  if ($ids.Count -gt 1) { Write-Host "命中多個帳號，改用 -UserId 指定。" -ForegroundColor Yellow; exit 1 }
  $scopeId = $ids[0].id
}

# ── SQL 片段 ───────────────────────────────────────────────────────
# 引擎判定與 services.ts 的 isKimiModel 同一條規則（^kimi|^moonshot），兩邊不可各自為政。
$ENGC = "case when c.model ~* '^(kimi|moonshot)' then 'KIMI' " +
        "when c.model ~* '^claude' then 'CLAUDE' " +
        "when c.model is null then '(未記錄)' else '其他' end"
$ENGU = "case when u.model ~* '^(kimi|moonshot)' then 'KIMI' " +
        "when u.model ~* '^claude' then 'CLAUDE' else '其他' end"

# 日運卦一律排除：它不給應期、不建 feedback，混進來只會稀釋所有比例。
$NOTFORTUNE = "coalesce(c.category,'') <> '日運'"
$SCOPEC = if ($scopeId) { " and c.user_id = " + (Q $scopeId) + "::uuid" } else { "" }
$SCOPEU = if ($scopeId) { " and u.user_id = " + (Q $scopeId) + "::uuid" } else { "" }
$WINC   = if ($Days -gt 0) { " and c.created_at >= now() - interval '$Days days'" } else { "" }
$WINU   = if ($Days -gt 0) { " and u.created_at >= now() - interval '$Days days'" } else { "" }

# 解卦家族：一張卦從初解到追問、展開、換人評卦的全部 AI 開銷。
# chat／fortune／monthly 不在內——那三個與「解卦引擎選誰」無關，另段列出。
$INTERPRET_MODES = "('cast','followup','comment','deepen','deepen_cont')"

# 單價解析：不呼叫 price_of()，改用 lateral 自己做最長前綴比對。
# 少依賴一支 function，這支就不會因為 0043 沒跑到而整個掛掉。
$PRICE_JOIN =
  "left join lateral (select mp.* from model_prices mp " +
  "where u.model like mp.model_prefix || '%' " +
  "order by length(mp.model_prefix) desc limit 1) pr on true "

# KIMI 走參數單價、其餘走 model_prices。認不出來又不是 KIMI 的，usd 記 0 並在 unpriced 計數——
# 這個計數不為零時，成本欄全部是低估，報表下方會叫。
# 小數點一律用不變文化寫進 SQL：作業系統若是逗號小數點的地區設定，
# "0,95" 會讓 Postgres 把一個參數讀成兩個，而它不會報錯，只會算出一個錯的金額。
$INV = [System.Globalization.CultureInfo]::InvariantCulture
$kIn = $KimiIn.ToString($INV); $kOut = $KimiOut.ToString($INV); $kCR = $KimiCacheRead.ToString($INV)
$USD =
  "case when u.model ~* '^(kimi|moonshot)' then " +
  "  u.tokens_in/1e6*$kIn + u.cache_write_tokens/1e6*$kIn " +
  "  + u.cache_read_tokens/1e6*$kCR + u.tokens_out/1e6*$kOut " +
  "else coalesce(u.tokens_in/1e6*pr.usd_in + u.cache_write_tokens/1e6*pr.usd_cache_write " +
  "  + u.cache_read_tokens/1e6*pr.usd_cache_read + u.tokens_out/1e6*pr.usd_out, 0) end"


# ── 查詢 ───────────────────────────────────────────────────────────

# 1. 引擎時間軸：切換發生在哪個月，一眼看出來
$SQL_TIMELINE =
  "select to_char(c.created_at at time zone 'Asia/Taipei','YYYY-MM') as ym, " +
  "$ENGC as engine, count(*) as n, " +
  "count(*) filter (where c.due_date is not null) as due, " +
  "count(*) filter (where f.verdict in (1,2,3)) as answered " +
  "from casts c left join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE$SCOPEC$WINC group by 1,2 order by 1,2;"

# 2. 型號明細：同一引擎下換過哪些型號、各自的起訖日
$SQL_MODELS =
  "select coalesce(c.model,'(未記錄)') as model, $ENGC as engine, count(*) as n, " +
  "to_char(min(c.created_at) at time zone 'Asia/Taipei','YYYY-MM-DD') as first_at, " +
  "to_char(max(c.created_at) at time zone 'Asia/Taipei','YYYY-MM-DD') as last_at " +
  "from casts c where $NOTFORTUNE$SCOPEC$WINC group by 1,2 order by min(c.created_at);"

# 3. 主表：每個引擎的卦數、應期給出率、回報率、應驗分佈
#    lag_days＝從應期到回評隔了幾天。兩個引擎若差很多，代表回報族群不同，比例就不能直接比。
$SQL_MAIN =
  "select $ENGC as engine, " +
  "count(*) as casts, " +
  "count(distinct c.user_id) as users, " +
  "count(*) filter (where c.due_date is not null) as due_total, " +
  "count(*) filter (where c.due_date is not null and c.due_date <= current_date) as due_arrived, " +
  "count(*) filter (where f.verdict in (1,2,3)) as answered, " +
  "count(*) filter (where f.verdict = 1) as hit, " +
  "count(*) filter (where f.verdict = 2) as part, " +
  "count(*) filter (where f.verdict = 3) as miss, " +
  "count(*) filter (where f.verdict in (1,2,3) and coalesce(f.note,'') <> '') as noted, " +
  "count(*) filter (where c.deep_reading is not null) as deepened, " +
  "round(avg(c.tokens_out)) as avg_out, " +
  "round(avg(extract(epoch from (f.answered_at - f.due_date::timestamptz))/86400)::numeric,1) as lag_days " +
  "from casts c left join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE$SCOPEC$WINC group by 1 order by 1;"

# 3b. 同一張表按型號再切一次。實測資料裡 CLAUDE 底下混了 sonnet 與 haiku
#     （haiku 是日運與早期追問用的），把兩者併成一個品牌會讓每卦成本與卦數失真，
#     而真正要決定的是「哪一個型號當主力」。
$SQL_MAIN_MODEL =
  "select coalesce(c.model,'(未記錄)') as model, " +
  "count(*) as casts, " +
  "count(*) filter (where c.due_date is not null) as due_total, " +
  "count(*) filter (where c.due_date is not null and c.due_date <= current_date) as due_arrived, " +
  "count(*) filter (where f.verdict in (1,2,3)) as answered, " +
  "count(*) filter (where f.verdict = 1) as hit, " +
  "count(*) filter (where f.verdict = 2) as part, " +
  "count(*) filter (where f.verdict = 3) as miss " +
  "from casts c left join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE$SCOPEC$WINC group by 1 order by count(*) desc;"

# 4. 追問次數：卦解得清不清楚的旁證（同一批卦被追問越多，通常是首解沒講明白）
$SQL_FOLLOWUP =
  "select $ENGC as engine, count(*) as followups " +
  "from followups fu join casts c on c.id = fu.cast_id " +
  "where $NOTFORTUNE$SCOPEC$WINC group by 1;"

# 5. 分類拆解：兩個引擎的題目組成不同時，總準確率會騙人
$SQL_BYCAT =
  "select coalesce(c.category,'(無)') as cat, $ENGC as engine, " +
  "count(*) as n, " +
  "count(*) filter (where f.verdict = 1) as hit, " +
  "count(*) filter (where f.verdict = 2) as part, " +
  "count(*) filter (where f.verdict = 3) as miss " +
  "from casts c join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE and f.verdict in (1,2,3)$SCOPEC$WINC group by 1,2 order by 1,2;"

# 6. 擬題與否：0028 埋的那個對照組（question_source），順手一起看
$SQL_BYSRC =
  "select coalesce(c.question_source,'(未記錄)') as src, $ENGC as engine, " +
  "count(*) as n, count(*) filter (where f.verdict = 1) as hit " +
  "from casts c join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE and f.verdict in (1,2,3)$SCOPEC$WINC group by 1,2 order by 1,2;"

# 7. 成本：引擎 × mode
$SQL_COST =
  "select $ENGU as engine, u.mode, count(*) as calls, " +
  "sum(u.tokens_in) as t_in, sum(u.cache_write_tokens) as cw, " +
  "sum(u.cache_read_tokens) as cr, sum(u.tokens_out) as t_out, " +
  "count(*) filter (where u.estimated) as est, " +
  "count(*) filter (where pr.model_prefix is null and u.model !~* '^(kimi|moonshot)') as unpriced, " +
  "round(sum($USD)::numeric, 6) as usd " +
  "from ai_usage u $PRICE_JOIN " +
  "where u.mode in $INTERPRET_MODES$SCOPEU$WINU group by 1,2 order by 1,2;"

# 8. 非解卦開銷（chat／fortune／monthly）：與選引擎無關，但要知道它佔多少，
#    免得把整包帳算到解卦頭上。
$SQL_COST_OTHER =
  "select $ENGU as engine, u.mode, count(*) as calls, " +
  "round(sum($USD)::numeric, 6) as usd " +
  "from ai_usage u $PRICE_JOIN " +
  "where u.mode not in $INTERPRET_MODES$SCOPEU$WINU group by 1,2 order by 1,2;"

# 9. 回評評語：數字之外唯一能讀的東西。未應（3）排前面。
$SQL_NOTES =
  "select $ENGC as engine, f.verdict, " +
  "to_char(c.created_at at time zone 'Asia/Taipei','YY-MM-DD') as at, " +
  "coalesce(c.category,'-') as cat, c.gua_ben as gua, c.question, f.note " +
  "from casts c join feedback f on f.cast_id = c.id " +
  "where $NOTFORTUNE and f.verdict in (1,2,3) and coalesce(f.note,'') <> ''$SCOPEC$WINC " +
  "order by (f.verdict = 3) desc, c.created_at desc limit $NoteN;"

if ($Sql) {
  $all = @(
    @{ n = "1 引擎時間軸";     q = $SQL_TIMELINE },
    @{ n = "2 型號明細";       q = $SQL_MODELS },
    @{ n = "3 主表";           q = $SQL_MAIN },
    @{ n = "3b 主表（按型號）"; q = $SQL_MAIN_MODEL },
    @{ n = "4 追問次數";       q = $SQL_FOLLOWUP },
    @{ n = "5 分類拆解";       q = $SQL_BYCAT },
    @{ n = "6 擬題對照";       q = $SQL_BYSRC },
    @{ n = "7 解卦成本";       q = $SQL_COST },
    @{ n = "8 非解卦成本";     q = $SQL_COST_OTHER },
    @{ n = "9 回評評語";       q = $SQL_NOTES }
  )
  foreach ($s in $all) {
    Write-Host ""
    Write-Host "-- ── $($s.n) ──" -ForegroundColor Cyan
    Write-Host $s.q
  }
  exit 0
}


# ── 統計小工具 ─────────────────────────────────────────────────────
# Wilson 95% 區間：樣本小的時候，用 hit/n 直接比大小會得出完全錯誤的結論。
# 這個區間會誠實地寬——寬到兩個引擎重疊，就是「還分不出來」，那才是正確答案。
function Wilson {
  param([int]$k, [int]$n)
  if ($n -le 0) { return @{ lo = 0; hi = 0; p = 0 } }
  $z = 1.96; $p = $k / $n
  $d = 1 + $z * $z / $n
  $c = ($p + $z * $z / (2 * $n)) / $d
  $h = $z * [math]::Sqrt($p * (1 - $p) / $n + $z * $z / (4 * $n * $n)) / $d
  # 用 0.0 / 1.0 而不是 0 / 1：整數字面量會讓 PowerShell 選到 Max(int,int) 的多載，
  # 把 double 四捨五入成整數——區間於是永遠變成 0–100%，而且不報錯。
  return @{ lo = [math]::Max(0.0, $c - $h); hi = [math]::Min(1.0, $c + $h); p = $p }
}
# erf 近似（Abramowitz-Stegun 7.1.26），只為了把 z 換成 p 值。
function Erf {
  param([double]$x)
  $s = if ($x -lt 0) { -1 } else { 1 }; $x = [math]::Abs($x)
  $t = 1 / (1 + 0.3275911 * $x)
  $y = 1 - ((((1.061405429 * $t - 1.453152027) * $t + 1.421413741) * $t - 0.284496736) * $t + 0.254829592) * $t * [math]::Exp(-$x * $x)
  return $s * $y
}
function TwoPropP {
  param([int]$k1, [int]$n1, [int]$k2, [int]$n2)
  if ($n1 -le 0 -or $n2 -le 0) { return $null }
  $p1 = $k1 / $n1; $p2 = $k2 / $n2; $pp = ($k1 + $k2) / ($n1 + $n2)
  $se = [math]::Sqrt($pp * (1 - $pp) * (1 / $n1 + 1 / $n2))
  if ($se -eq 0) { return $null }
  $z = ($p1 - $p2) / $se
  return 2 * (1 - 0.5 * (1 + (Erf ([math]::Abs($z) / [math]::Sqrt(2)))))
}
function Pct { param($k, $n) if ($n -gt 0) { [math]::Round(100.0 * $k / $n, 1) } else { $null } }


# ── 抬頭 ───────────────────────────────────────────────────────────
$span = if ($Days -gt 0) { "近 $Days 天" } else { "全部歷史" }
$who  = if ($scopeId) { "帳號 $scopeId" } else { "全站" }
Write-Host ""
Write-Host "═══ 解卦引擎對照：CLAUDE vs KIMI ═══" -ForegroundColor Cyan
Write-Host "範圍　$who・$span・排除日運卦" -ForegroundColor DarkGray
Write-Host "單價　Claude 讀 model_prices；KIMI 用參數 in=`$$KimiIn / out=`$$KimiOut / cache_read=`$$KimiCacheRead 每百萬 token；匯率 $Twd" -ForegroundColor DarkGray
Write-Host "　　　（KIMI 單價非資料庫事實，對過 Moonshot 帳單後請插進 model_prices）" -ForegroundColor DarkGray


# ── 1. 引擎時間軸 ──────────────────────────────────────────────────
Write-Host ""
Write-Host "── 一、引擎時間軸（哪個月換的） ──" -ForegroundColor Cyan
$tl = @(Invoke-Sql $SQL_TIMELINE)
if (-not $tl) { Write-Host "這個範圍內沒有問事卦。" -ForegroundColor Yellow; exit 0 }
$months = $tl | ForEach-Object { $_.ym } | Sort-Object -Unique
$tlRows = foreach ($ym in $months) {
  $r = $tl | Where-Object { $_.ym -eq $ym }
  $g = { param($e) ($r | Where-Object { $_.engine -eq $e } | Measure-Object -Property n -Sum).Sum }
  [pscustomobject]@{
    月      = $ym
    CLAUDE  = [int](& $g 'CLAUDE')
    KIMI    = [int](& $g 'KIMI')
    其他    = [int]((& $g '其他') + (& $g '(未記錄)'))
    給應期  = [int]($r | Measure-Object -Property due -Sum).Sum
    已回評  = [int]($r | Measure-Object -Property answered -Sum).Sum
  }
}
$tlRows | Format-Table -Property * -AutoSize

Write-Host "型號明細" -ForegroundColor DarkGray
@(Invoke-Sql $SQL_MODELS) | ForEach-Object {
  [pscustomobject]@{ 型號 = $_.model; 引擎 = $_.engine; 卦數 = $_.n; 首次 = $_.first_at; 最後 = $_.last_at }
} | Format-Table -Property * -AutoSize


# ── 2. 主表 ────────────────────────────────────────────────────────
Write-Host "── 二、有應期回報的卦：準確度 ──" -ForegroundColor Cyan
$main = @(Invoke-Sql $SQL_MAIN)
$fu   = @(Invoke-Sql $SQL_FOLLOWUP)
# 兩張表分開印：欄位太多時 Format-Table 會從右邊砍（見上方 -Property * 那段），
# 且一行超過主控台寬度就要折行。準確度歸準確度，旁證歸旁證。
$rows = foreach ($m in $main) {
  $n = [int]$m.answered
  $w = Wilson ([int]$m.hit) $n
  [pscustomobject]@{
    引擎     = $m.engine
    卦數     = $m.casts
    給應期   = $m.due_total
    應期已到 = $m.due_arrived
    已回評   = $n
    回報率   = "$(Pct $m.answered $m.due_arrived)%"
    應驗     = $m.hit
    部分     = $m.part
    未應     = $m.miss
    應驗率   = "$(Pct $m.hit $n)%"
    加權分   = $(if ($n -gt 0) { "$([math]::Round(100.0 * ([int]$m.hit + 0.5 * [int]$m.part) / $n, 1))%" } else { "" })
    '95%CI'  = $(if ($n -gt 0) { "$([math]::Round(100*$w.lo,1))-$([math]::Round(100*$w.hi,1))%" } else { "" })
  }
}
$rows | Format-Table -Property * -AutoSize
Write-Host "應驗率＝應驗÷已回評；加權分＝(應驗+0.5×部分)÷已回評；回報率＝已回評÷應期已到的卦" -ForegroundColor DarkGray
Write-Host "95%CI＝應驗率的 Wilson 信賴區間。兩個引擎的區間重疊，就是還分不出高下。" -ForegroundColor DarkGray

Write-Host ""
Write-Host "同一批卦按型號切（品牌底下不只一個型號時，這張才是決策用的）" -ForegroundColor DarkGray
$byModel = foreach ($m in @(Invoke-Sql $SQL_MAIN_MODEL)) {
  $n = [int]$m.answered
  $w = Wilson ([int]$m.hit) $n
  [pscustomobject]@{
    型號     = $m.model
    卦數     = $m.casts
    給應期   = $m.due_total
    應期已到 = $m.due_arrived
    已回評   = $n
    應驗     = $m.hit
    部分     = $m.part
    未應     = $m.miss
    應驗率   = "$(Pct $m.hit $n)%"
    '95%CI'  = $(if ($n -gt 0) { "$([math]::Round(100*$w.lo,1))-$([math]::Round(100*$w.hi,1))%" } else { "" })
  }
}
$byModel | Format-Table -Property * -AutoSize

Write-Host ""
Write-Host "旁證（不靠回評，看得出批文品質與回報行為的差別）" -ForegroundColor DarkGray
$side = foreach ($m in $main) {
  $f = ($fu | Where-Object { $_.engine -eq $m.engine } | Select-Object -First 1)
  [pscustomobject]@{
    引擎     = $m.engine
    人數     = $m.users
    應期給出率 = "$(Pct $m.due_total $m.casts)%"
    追問率   = $(if ([int]$m.casts -gt 0 -and $f) { "$([math]::Round(1.0 * [int]$f.followups / [int]$m.casts, 2))" } else { "0" })
    展開率   = "$(Pct $m.deepened $m.casts)%"
    平均輸出 = $m.avg_out
    回評延遲 = $m.lag_days
  }
}
$side | Format-Table -Property * -AutoSize
Write-Host "應期給出率＝模型願意給明確應期的比例（給不出來就沒有回評閉環，這欄太低會餓死上面那張表）" -ForegroundColor DarkGray
Write-Host "追問率＝每卦平均追問次數（越高越可能是首解沒講清楚）；回評延遲＝應期到回評相隔天數" -ForegroundColor DarkGray

# 顯著性：兩個引擎都有樣本才比
$mc = $main | Where-Object { $_.engine -eq 'CLAUDE' } | Select-Object -First 1
$mk = $main | Where-Object { $_.engine -eq 'KIMI' }   | Select-Object -First 1
if ($mc -and $mk -and [int]$mc.answered -gt 0 -and [int]$mk.answered -gt 0) {
  $wc = Wilson ([int]$mc.hit) ([int]$mc.answered)
  $wk = Wilson ([int]$mk.hit) ([int]$mk.answered)
  $pv = TwoPropP ([int]$mc.hit) ([int]$mc.answered) ([int]$mk.hit) ([int]$mk.answered)
  $overlap = ($wc.lo -le $wk.hi) -and ($wk.lo -le $wc.hi)
  Write-Host ""
  if ($overlap) {
    Write-Host "判讀：兩邊的 95% 信賴區間重疊" -ForegroundColor Yellow
    Write-Host "　　　差距還在雜訊裡，樣本不足以說哪個更準。此時該用成本與延遲決定，不是用應驗率。" -ForegroundColor Yellow
  } else {
    Write-Host "判讀：信賴區間不重疊——差距看起來是真的" -ForegroundColor Green
  }
  if ($null -ne $pv) { Write-Host ("　　　兩比例檢定 p = {0:N3}（p<0.05 才算分得出來；n<30 時這個數字本身也不可靠）" -f $pv) -ForegroundColor DarkGray }
  # 只看兩個受測引擎——把 (未記錄) 那類算進來，最小值永遠是 0，這個警告就永遠在叫
  $minN = [math]::Min([int]$mc.answered, [int]$mk.answered)
  if ($minN -lt 30) {
    Write-Host "　　　⚠ 較小的一組只有 $minN 筆回評。低於 30 筆的準確率比較，讀個方向就好。" -ForegroundColor Yellow
  }
}


# ── 3. 分類與擬題拆解 ──────────────────────────────────────────────
Write-Host ""
Write-Host "── 三、分類拆解（題目組成不同會讓總準確率騙人） ──" -ForegroundColor Cyan
$bc = @(Invoke-Sql $SQL_BYCAT)
if ($bc) {
  $bc | ForEach-Object {
    [pscustomobject]@{
      類別 = $_.cat; 引擎 = $_.engine; 已回評 = $_.n
      應驗 = $_.hit; 部分 = $_.part; 未應 = $_.miss
      應驗率 = "$(Pct $_.hit $_.n)%"
    }
  } | Format-Table -Property * -AutoSize
} else { Write-Host "（沒有可拆的回評）" -ForegroundColor DarkGray }

$bs = @(Invoke-Sql $SQL_BYSRC)
if ($bs) {
  Write-Host "擬題對照（question_source）" -ForegroundColor DarkGray
  $bs | ForEach-Object {
    [pscustomobject]@{ 來源 = $_.src; 引擎 = $_.engine; 已回評 = $_.n; 應驗 = $_.hit; 應驗率 = "$(Pct $_.hit $_.n)%" }
  } | Format-Table -Property * -AutoSize
}


# ── 4. 成本 ────────────────────────────────────────────────────────
Write-Host "── 四、成本（解卦家族：初解／追問／評卦／展開） ──" -ForegroundColor Cyan
$cost = @(Invoke-Sql $SQL_COST)
if (-not $cost) {
  Write-Host "這個範圍內 ai_usage 沒有解卦紀錄。" -ForegroundColor Yellow
} else {
  $cost | ForEach-Object {
    [pscustomobject]@{
      引擎 = $_.engine; mode = $_.mode; 次數 = $_.calls
      輸入 = $_.t_in; 快取寫 = $_.cw; 快取讀 = $_.cr; 輸出 = $_.t_out
      台幣 = [math]::Round([decimal]$_.usd * $Twd, 2)
      每次 = [math]::Round([decimal]$_.usd * $Twd / [math]::Max([int]$_.calls, 1), 3)
      估算 = $_.est
    }
  } | Format-Table -Property * -AutoSize

  # 引擎層級的決策數字
  Write-Host "引擎小計與單位成本" -ForegroundColor DarkGray
  $sum = foreach ($e in @('CLAUDE', 'KIMI', '其他')) {
    $c = $cost | Where-Object { $_.engine -eq $e }
    if (-not $c) { continue }
    $usd = ($c | ForEach-Object { [decimal]$_.usd } | Measure-Object -Sum).Sum
    $twdT = [math]::Round($usd * $Twd, 2)
    $m = $main | Where-Object { $_.engine -eq $e } | Select-Object -First 1
    $casts = if ($m) { [int]$m.casts } else { 0 }
    $hits  = if ($m) { [int]$m.hit } else { 0 }
    $ans   = if ($m) { [int]$m.answered } else { 0 }
    $cw = ($c | ForEach-Object { [long]$_.cw } | Measure-Object -Sum).Sum
    $cr = ($c | ForEach-Object { [long]$_.cr } | Measure-Object -Sum).Sum
    [pscustomobject]@{
      引擎       = $e
      台幣合計   = $twdT
      卦數       = $casts
      每卦台幣   = $(if ($casts -gt 0) { [math]::Round($twdT / $casts, 3) } else { $null })
      已回評     = $ans
      應驗       = $hits
      每次應驗   = $(if ($hits -gt 0) { [math]::Round($twdT / $hits, 2) } else { "—" })
      快取命中率 = $(if (($cw + $cr) -gt 0) { "$([math]::Round(100.0 * $cr / ($cw + $cr), 1))%" } else { "無快取" })
    }
  }
  $sum | Format-Table -Property * -AutoSize
  Write-Host "每次應驗＝該引擎解卦總開銷 ÷ 應驗卦數。這是「買到一次準」要多少錢——決定主力模型看這欄，不是看每卦成本。" -ForegroundColor DarkGray

  $unpriced = ($cost | ForEach-Object { [int]$_.unpriced } | Measure-Object -Sum).Sum
  if ($unpriced -gt 0) {
    Write-Host ""
    Write-Host "⚠ 有 $unpriced 次呼叫的型號在 model_prices 找不到單價，已當 0 元計入。" -ForegroundColor Red
    Write-Host "　上面所有成本都是低估。先補 model_prices 那一列，再讀這份報表。" -ForegroundColor Red
  }
  $kimiNoCache = $cost | Where-Object { $_.engine -eq 'KIMI' -and [long]$_.cr -eq 0 -and [int]$_.calls -gt 0 }
  if ($kimiNoCache) {
    Write-Host ""
    Write-Host "註：KIMI 沒有任何快取讀取。services.ts 的 KIMI 路徑沒有帶 Moonshot 的 context cache，" -ForegroundColor DarkGray
    Write-Host "　　也沒收 cached_tokens，所以每一次呼叫都付全額輸入（卦理規則約 9,500 token）。" -ForegroundColor DarkGray
    Write-Host "　　Claude 這側走 1h 快取、讀取只要 0.1 倍價。比成本時這是最大的一項結構差異。" -ForegroundColor DarkGray
  }
}

$other = @(Invoke-Sql $SQL_COST_OTHER)
if ($other) {
  Write-Host ""
  Write-Host "非解卦開銷（閒聊／日運／月誌，與選引擎無關，列出來免得算錯帳）" -ForegroundColor DarkGray
  $other | ForEach-Object {
    [pscustomobject]@{ 引擎 = $_.engine; mode = $_.mode; 次數 = $_.calls; 台幣 = [math]::Round([decimal]$_.usd * $Twd, 2) }
  } | Format-Table -Property * -AutoSize
}


# ── 5. 回評評語 ────────────────────────────────────────────────────
if ($Notes) {
  Write-Host "── 五、回評評語（未應的排前面） ──" -ForegroundColor Cyan
  $nt = @(Invoke-Sql $SQL_NOTES)
  if (-not $nt) {
    Write-Host "（沒有留評語的回評）" -ForegroundColor DarkGray
  } else {
    $V = @{ 1 = "應驗"; 2 = "部分"; 3 = "未應" }
    foreach ($r in $nt) {
      $tag = $V[[int]$r.verdict]
      $col = if ([int]$r.verdict -eq 3) { "Red" } elseif ([int]$r.verdict -eq 2) { "Yellow" } else { "Green" }
      Write-Host ""
      Write-Host "[$($r.engine)] $tag　$($r.at)　$($r.cat)　《$($r.gua)》" -ForegroundColor $col
      Write-Host "　問：$($r.question)"
      Write-Host "　評：$($r.note)"
    }
  }
}


# ── 讀這份報表的三個陷阱 ───────────────────────────────────────────
Write-Host ""
Write-Host "── 讀之前先知道 ──" -ForegroundColor Cyan
Write-Host "1. 回報是自選的。願意回來點「準不準」的人本來就偏向有感覺的那一批；兩個引擎的回報率若差很多，"
Write-Host "   準確率就不是同一個母體的數字，不能直接比大小。回報率那一欄先看。"
Write-Host "2. 時段不同就不只換了模型。切換前後可能還同時改過 rules.ts、用神取法、擬題流程——"
Write-Host "   準確率的差可能來自那些，不是模型。要乾淨的答案只有一條路：同一段時間隨機分流跑 A/B。"
Write-Host "3. 應期回報驗的是「整段批文準不準」，不只是應期日對不對。verdict 沒有分開記這兩件事。"
