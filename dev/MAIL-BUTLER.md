# 信箱管家＋產品週報：設定步驟

觀主個人用的 Telegram 管家，用**獨立的私人 bot：@JjizhiMailbot**（函式 `admin-tg`），不跟對外的卜卦 bot（`webhook-tg`）共用。
拆開的理由：改管家不必重新部署對外服務、指令不會撞名、私人信件不流經產品程式、一把 token 出事不會兩邊一起斷。
這個 bot 只認 `ADMIN_TG_ID` 一人，其他人傳什麼都不回。

| 做什麼 | 什麼時候 | 怎麼做 |
| --- | --- | --- |
| 整理 Gmail 收件匣 | 每 2 小時 | 規則 → 守門字 → Haiku 5.5 判斷；刪的丟垃圾桶（30 天自動清） |
| 匯報需要知道的信 | 有才發 | 一則摘要：寄件人＋主旨＋一句「你要知道什麼／做什麼」 |
| 拿不準的問你 | 每輪最多推 8 則 | 每則附按鈕：刪／留／這寄件人以後都刪／整個網域都刪／以後都報給我 → 自動長出規則 |
| 產品週報 | 每週一 09:03（台北） | 新註冊、週活躍、留存、起卦／追問／閒聊、角色與問事分布、準驗、收入、AI 成本、毛利 |

**判斷順序**：你的規則 ＞ 守門字 ＞ AI。
**刪除安全線**：AI 要自動刪，必須同時滿足 ① 信心 ≥ 0.85 ② 是廣告型信（促銷／社交／論壇分類，或帶退訂標頭）③ 沒命中守門字（銀行、帳單、驗證碼、政府、合約、建案、綠界…，清單在 `_shared/mailbot.ts` 的 `GUARD`）。任一不符就改成問你。
**只讀標頭與摘要**，不讀信件內文。

TG 指令（在 @JjizhiMailbot 裡打）：`/mail_help`、`/mailnow`、`/mailask`、`/maillog`（自動刪的可救回）、`/mailrules`、`/mailrule add|del`、`/week`。

---

## 第 1 步 · 在 Google 拿到 Gmail 授權（一次性，約 15 分鐘）

1. 開 <https://console.cloud.google.com/> → 建一個專案（名字隨意，例如 `cangwang-mailbot`）。
2. 「API 和服務 → 程式庫」搜 **Gmail API** → 啟用。
3. 「API 和服務 → OAuth 同意畫面」：
   - 類型選 **外部（External）**，應用程式名稱隨意，支援信箱填自己。
   - 範圍（Scopes）加 `https://www.googleapis.com/auth/gmail.modify`。
   - **發布狀態按「發布應用程式（Publish app）」改成「實際運作中」**。
     ⚠ 停在「測試中」的話，refresh token **7 天就失效**，管家會在一週後突然報錯 `invalid_grant`。
     發布後不需要送 Google 審核——只有你自己用，登入時會看到「Google 尚未驗證這個應用程式」，按「進階 → 繼續前往」即可。
4. 「API 和服務 → 憑證 → 建立憑證 → OAuth 用戶端 ID」：
   - 類型 **網頁應用程式**
   - 已授權的重新導向 URI：`https://developers.google.com/oauthplayground`
   - 建好後記下 **用戶端 ID** 與 **用戶端密碼**。
5. 開 <https://developers.google.com/oauthplayground>：
   - 右上角齒輪 → 勾 **Use your own OAuth credentials** → 貼上剛才的 ID 與密碼。
   - 左邊最下面輸入框貼 `https://www.googleapis.com/auth/gmail.modify` → **Authorize APIs** → 用要整理的那個 Gmail 登入、同意。
   - **Exchange authorization code for tokens** → 複製 **Refresh token**。

> 為什麼是 `gmail.modify` 而不是完整權限：它可以讀標頭、丟垃圾桶、救回，但**不能永久刪除**。
> token 萬一外洩，損失上限是「信被丟進垃圾桶」，而不是整個信箱被清空。空間一樣會回來（垃圾桶 30 天自動清）。

## 第 2 步 · 設 secret

```powershell
npx supabase secrets set GMAIL_CLIENT_ID=你的用戶端ID          --project-ref ajogafvzlhqwlxwkfcpn
npx supabase secrets set GMAIL_CLIENT_SECRET=你的用戶端密碼    --project-ref ajogafvzlhqwlxwkfcpn
npx supabase secrets set GMAIL_REFRESH_TOKEN=你的RefreshToken  --project-ref ajogafvzlhqwlxwkfcpn
```

管家 bot 的兩把（BotFather 給的 token；webhook 暗號自己編一串長的英數）：

```powershell
npx supabase secrets set ADMIN_BOT_TOKEN=BotFather給的token          --project-ref ajogafvzlhqwlxwkfcpn
npx supabase secrets set ADMIN_TG_WEBHOOK_SECRET=自己編的一串英數    --project-ref ajogafvzlhqwlxwkfcpn
```

其餘沿用既有的：`ADMIN_TG_ID`、`BROADCAST_INTERNAL_SECRET`、`ANTHROPIC_API_KEY`。

選填：

| secret | 預設 | 用途 |
| --- | --- | --- |
| `MAILBOT_MODEL` | `claude-haiku-5-5` | 分類用的模型 |
| `MAILBOT_QUERY` | `in:inbox newer_than:3d` | 掃描範圍（Gmail 搜尋語法） |
| `MAILBOT_MAX` | `60` | 每輪最多看幾封 |
| `MAILBOT_MAX_ASK` | `8` | 每輪最多推幾則「要刪嗎」 |

## 第 3 步 · 上 migration 與部署

```powershell
.\dev\migrate.ps1 -Apply -Only 0091_mail_butler.sql
.\dev\migrate.ps1 -Apply -Only 0092_mailbot_labels.sql   # 期限標籤、明確授權、起始規則   # 本專案一律走 migrate.ps1，不可用 supabase db push（見 deploy-howto.md 第 1 步）
supabase functions deploy mail-butler --project-ref ajogafvzlhqwlxwkfcpn --no-verify-jwt
supabase functions deploy admin-tg    --project-ref ajogafvzlhqwlxwkfcpn --no-verify-jwt
```

`--no-verify-jwt` 兩支都不能省（理由同 `deploy-howto.md` 第 3 步）。

把 Telegram 接到 admin-tg（一次性；兩處換成你的值）：

```powershell
Invoke-RestMethod "https://api.telegram.org/bot<ADMIN_BOT_TOKEN>/setWebhook?url=https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/admin-tg&secret_token=<ADMIN_TG_WEBHOOK_SECRET>"
```

回 `ok : True` 就接上了。接著到 Telegram 打開 @JjizhiMailbot **先按「開始」（/start）**——
Telegram 規定 bot 不能主動傳訊息給沒按過開始的人，不按的話管家的匯報一封都送不到。

然後打 `/mailnow` 試跑一輪、`/week` 看週報，確定都有回應再設排程。

## 第 4 步 · 排程（SQL Editor 貼一次）

排程要帶 internal secret，所以不寫進 migration（同 `due-reminder-daily`）。把 `<SECRET>` 換成 `BROADCAST_INTERNAL_SECRET` 的值：

```sql
-- 每 2 小時整理一次（UTC 每偶數小時的第 5 分）
select cron.schedule('mail-butler-triage', '5 */2 * * *', $$
  select net.http_post(
    url     := 'https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/mail-butler',
    headers := jsonb_build_object('content-type','application/json','x-internal-secret','<SECRET>'),
    body    := '{"job":"triage"}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- 每週一 台北 09:03（= UTC 週一 01:03）發週報，報的是上週一到週日
select cron.schedule('mail-butler-weekly', '3 1 * * 1', $$
  select net.http_post(
    url     := 'https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/mail-butler',
    headers := jsonb_build_object('content-type','application/json','x-internal-secret','<SECRET>'),
    body    := '{"job":"weekly"}'::jsonb);
$$);
```

改頻率：`select cron.unschedule('mail-butler-triage');` 再重設。

## 頭幾天的用法

- 第一輪會問比較多，因為還沒有規則。看到成批的廣告，直接按「整個網域都刪」，一按就把待決清單裡同網域的一起清掉。
- 重要的寄件人（家人、合作窗口、建商）按「以後都報給我」，之後必定匯報、永不被刪。
- 覺得 AI 刪錯了：`/maillog` → ♻ 救回，同時自動記一條「這寄件人以後留著」。
- 守門字太敏感或不夠：改 `_shared/mailbot.ts` 的 `GUARD`，跑 `node dev/mailbot-test.mts`。

## 出錯時

管家出錯會直接推一則 ⚠️ 到 TG。最常見的：

| 訊息 | 原因 | 處理 |
| --- | --- | --- |
| `gmail token 400 invalid_grant` | OAuth 還在「測試中」過了 7 天，或你在 Google 帳號撤銷了授權 | 第 1 步第 3 點改成發布，重做第 5 點換新 token，重設 `GMAIL_REFRESH_TOKEN` |
| `gmail ... 403` | Gmail API 沒啟用，或 scope 不是 `gmail.modify` | 第 1 步第 2、5 點 |
| `週報算不出來` | migration 0091 沒上 | 第 3 步 |

## 保留期限標籤（2026-10-19 起）

管家照「要留多久」分類，不照主題。標籤清單在 `_shared/mailbot.ts` 的 `LABELS`，必須與 Gmail 上的名稱逐字一致：

| 層 | 標籤 | 到期 |
| --- | --- | --- |
| 三月 | 水電瓦斯、保險通知、帳單繳費 | 3 個月後由週報那一輪丟垃圾桶 |
| 五年 | 外包收入、保固憑證、產品營運、錄取通知 | 5 年後丟垃圾桶 |
| 永久 | 合約明細、房產、金鑰序號、重要內容 | 不動 |
| 待辦 | 要動手的、日期在未來的 | 不動；週報列出件數與最舊天數 |

- 只有「留下來」（回報或留存）的信會貼標籤；規則的 `label` 優先於 AI 的建議，AI 編出清單外的標籤一律丟掉。
- 到期清理每週一跑一次，一次最多 `MAILBOT_SWEEP_MAX`（預設 300）封，清不完下週繼續。
- 在 Gmail 新增或改名標籤，要同步改 `LABELS` 與 `SWEEP`，跑 `node dev/mailbot-test.mts`。
