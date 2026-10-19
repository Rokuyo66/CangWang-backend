# 信箱管家（66-butler）

觀主私人的 Gmail 管家，**獨立的 Supabase 專案**，與產品（藏往知來／CangWang）完全分開：
產品資料庫裡不存觀主的任何一封信，兩邊也不共用任何密碼。

| | 管家專案 66-butler | 產品專案 CangWangZhiLai |
| --- | --- | --- |
| Project ref | `nlyxvhxvqzwoqwpxharp` | `ajogafvzlhqwlxwkfcpn` |
| 程式 | `mailbot/supabase/functions/`：`mail-butler`（整理）、`admin-tg`（TG bot） | `supabase/functions/weekly-report`（產品週報） |
| 資料 | `mailbot_rules`、`mailbot_seen`、`mailbot_labels` | 產品數據；`admin_weekly_stats()` |
| 排程 | 每 2 小時整理、週一 09:03 到期清理＋信箱週報 | 週一 09:03 產品週報 |
| TG | @JjizhiMailbot 的 webhook 接在這裡 | 只借 bot token 發週報 |

`/week` 是管家 bot 去叫產品專案的 `weekly-report`（帶 `REPORT_SECRET`），週報由產品那邊讀完數據直接送來。

---

## 它做什麼

**收件匣清零**：收件匣只放「待辦」和還沒處理的信；其他一律歸檔、標已讀，左欄不掛未讀數。

| 信 | 去處 |
| --- | --- |
| 廣告、規則要刪的 | 垃圾桶（30 天內撿得回來） |
| 規則指定了標籤的、AI 有把握（≥0.85）的留存信 | 自動歸檔：貼標籤、移出收件匣、標已讀 |
| 其餘（要看的、拿不準的） | 留在收件匣未讀，TG 推歸檔卡：⭐推薦、備選、🆕新分類建議、📌待辦、🗑刪 |

- 卡上按完分類會再問「以後都放這」，按下去就長成規則。
- **刪除安全線**：AI 自動刪要同時滿足信心 ≥0.85、廣告型信、沒命中守門字（銀行、帳單、驗證碼、合約、建案…，`mailbot.ts` 的 `GUARD`）。
- 只讀標頭與摘要，不讀內文。Gmail 授權是 `gmail.modify`：能歸檔、丟垃圾桶，**不能永久刪除**。

**保留期限標籤**（照「要留多久」分，不照主題）：

| 層 | 標籤 | 到期 |
| --- | --- | --- |
| 三月 | 水電瓦斯、保險通知、帳單繳費 | 3 個月後由週一那一輪丟垃圾桶 |
| 五年 | 外包收入、保固憑證、產品營運、錄取通知 | 5 年後丟垃圾桶 |
| 永久 | 合約明細、房產、金鑰序號、重要內容 | 不動 |
| 待辦 | 要動手的、日期在未來的 | 不動；週報列件數與最舊天數 |

自建分類（TG 按「🆕」）只准 `三月/`、`五年/`、`永久/` 開頭、2～8 字，存 `mailbot_labels`，AI 與到期清理自動納入。

TG 指令：`/mailnow`、`/mailtidy`（大掃除）、`/mailask`（重推卡片）、`/maillog`（救回自動刪的）、`/mailrules`、`/mailrule add|del`、`/week`。

---

## 設定（一次性）

以下 PowerShell 都在 repo 根目錄跑。

### 1. 建表

管家專案 → SQL Editor → 貼上 `mailbot/supabase/migrations/0001_mailbot.sql` 整份 → Run。

### 2. 兩把自己編的密碼

各產生一串（PowerShell 跑兩次，記下來）：

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

- `MAILBOT_CRON_SECRET`：管家專案的排程叫管家用。只存在管家專案。
- `REPORT_SECRET`：管家 `/week` 叫產品週報用。**兩個專案都要存同一串**。

### 3. 管家專案的 secret

```powershell
$B = "nlyxvhxvqzwoqwpxharp"
npx supabase secrets set --project-ref $B GMAIL_CLIENT_ID=… GMAIL_CLIENT_SECRET=… GMAIL_REFRESH_TOKEN=…
npx supabase secrets set --project-ref $B ADMIN_BOT_TOKEN=… ADMIN_TG_WEBHOOK_SECRET=…
npx supabase secrets set --project-ref $B ANTHROPIC_API_KEY=… MAILBOT_CRON_SECRET=… REPORT_SECRET=…
```

- Gmail 三個值與原本相同（Google Cloud 的用戶端 JSON、Playground 拿的 refresh token）。refresh token 沒留下來的話，重做一次 Playground 即可，不必重建 OAuth。
- `ANTHROPIC_API_KEY` 建議到 Anthropic Console **另開一把**（命名 mailbot），私人用量與產品成本分開。
- 也可以在網頁上填：管家專案 → Edge Functions → Secrets。

### 4. 部署管家

```powershell
supabase functions deploy mail-butler --project-ref nlyxvhxvqzwoqwpxharp --workdir mailbot --no-verify-jwt
supabase functions deploy admin-tg    --project-ref nlyxvhxvqzwoqwpxharp --workdir mailbot --no-verify-jwt
```

`--workdir mailbot` 不能漏：漏了會去部署產品資料夾，找不到這兩支。

### 5. bot 改接到管家專案

瀏覽器網址列貼上（兩處換成你的值）：

```
https://api.telegram.org/bot<ADMIN_BOT_TOKEN>/setWebhook?url=https://nlyxvhxvqzwoqwpxharp.supabase.co/functions/v1/admin-tg&secret_token=<ADMIN_TG_WEBHOOK_SECRET>
```

回 `"ok":true` 就接上了。到 TG 打 `/mailnow` 試一輪。

### 6. 管家專案的排程

管家專案 → SQL Editor（`<MAILBOT_CRON_SECRET>` 換成第 2 步那串，兩處）：

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('mail-butler-triage', '5 */2 * * *', $$
  select net.http_post(
    url := 'https://nlyxvhxvqzwoqwpxharp.supabase.co/functions/v1/mail-butler',
    headers := jsonb_build_object('content-type','application/json','x-internal-secret','<MAILBOT_CRON_SECRET>'),
    body := '{"job":"triage"}'::jsonb, timeout_milliseconds := 120000);
$$);
select cron.schedule('mail-butler-weekly', '3 1 * * 1', $$
  select net.http_post(
    url := 'https://nlyxvhxvqzwoqwpxharp.supabase.co/functions/v1/mail-butler',
    headers := jsonb_build_object('content-type','application/json','x-internal-secret','<MAILBOT_CRON_SECRET>'),
    body := '{"job":"weekly"}'::jsonb, timeout_milliseconds := 120000);
$$);
select jobname, schedule, active from cron.job;
```

`5 */2 * * *` 是 UTC 每偶數小時第 5 分（台北奇數點 :05）；`3 1 * * 1` 是台北週一 09:03。

---

## 產品專案那一側（搬家收尾）

### a. 規則帶過來（可略）

在 TG 按出來的規則若想保留：**產品專案** SQL Editor 跑下面這句，把結果那一整格複製，貼到**管家專案** SQL Editor 執行。
起始規則不必帶（0001 已內建）。沒有結果就代表沒有要帶的。

```sql
select 'insert into mailbot_rules (kind, pattern, action, label, note) values '
  || string_agg(format('(%L,%L,%L,%L,%L)', kind, pattern, action, label, note), ', ')
  || ' on conflict (kind, pattern) do nothing;'
from mailbot_rules where coalesce(note, '') not like '起始規則%';
```

### b. 刪掉產品裡的管家

```powershell
$P = "ajogafvzlhqwlxwkfcpn"
.\dev\migrate.ps1 -Apply -Only 0094_mailbot_moved_out.sql      # 週報拿掉信箱段、刪 mailbot_* 三張表
supabase functions delete mail-butler --project-ref $P
supabase functions delete admin-tg    --project-ref $P
npx supabase secrets unset --project-ref $P GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET GMAIL_REFRESH_TOKEN ADMIN_TG_WEBHOOK_SECRET
```

`ADMIN_BOT_TOKEN` **留著**：產品週報要用它發訊息。若之前在產品專案設過 `mail-butler-*` 排程：

```sql
select cron.unschedule(jobname) from cron.job where jobname like 'mail-butler%';
```

### c. 產品週報

```powershell
npx supabase secrets set --project-ref $P REPORT_SECRET=…        # 與管家專案同一串
supabase functions deploy weekly-report --project-ref $P --no-verify-jwt
```

產品專案 SQL Editor（`<REPORT_SECRET>` 換掉）：

```sql
select cron.schedule('weekly-report', '3 1 * * 1', $$
  select net.http_post(
    url := 'https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/weekly-report',
    headers := jsonb_build_object('x-report-secret','<REPORT_SECRET>'),
    timeout_milliseconds := 60000);
$$);
```

在管家 bot 打 `/week`，產品週報就會送來。

---

## 出錯時

管家出錯會直接推一則 ⚠️ 到 TG。

| 訊息 | 原因 | 處理 |
| --- | --- | --- |
| `gmail token 400 invalid_grant` | OAuth 同意畫面還在「測試中」過了 7 天，或授權被撤銷 | 發布 OAuth 應用程式，重做 Playground 換 token，重設 `GMAIL_REFRESH_TOKEN` |
| `gmail ... 403` | Gmail API 沒啟用，或 scope 不是 `gmail.modify` | Google Cloud 檢查 |
| `叫不到產品週報（403）` | 兩邊的 `REPORT_SECRET` 不一致 | 兩個專案重設同一串 |
| bot 完全不回話 | webhook 沒接到管家專案、或暗號不一致 | 重做第 5 步；`getWebhookInfo` 看 `last_error_message` |

免費專案一週沒有活動會被暫停。排程每 2 小時叫一次管家，照理會維持活躍；若哪天收到 Supabase 的暫停通知，到後台按 Restore 即可。

## 開發

- 測試：`node mailbot/dev/mailbot-test.mts`
- 型別檢查：`deno check mailbot/supabase/functions/mail-butler/index.ts mailbot/supabase/functions/admin-tg/index.ts`
- 這個資料夾**不准 import 產品的檔案**（`supabase/functions/_shared/*`）：兩邊分開部署，import 了就把產品程式一起帶上管家專案。
- 在 Gmail 新增或改名固定標籤，要同步改 `mailbot.ts` 的 `LABELS`；自建的走 TG 按鈕即可。
