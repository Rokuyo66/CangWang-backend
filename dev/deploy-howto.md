# 部署：把改好的後端送上 Supabase

寫給「沒做過這件事」的人。每一步都寫了**你會看到什麼**，
看到的東西跟這裡寫的不一樣就先停下來問，不要硬往下走。

---

## 這是在做什麼

App 分兩半：

- **手機／網頁上跑的**（前端）— 由 GitHub Actions 打包成 APK，或由 Cloudflare 自動上線
- **雲端上跑的**（後端，在 Supabase）— 在你的帳號裡，只有你能更新

改動如果碰到後端，就要手動把它送上去。後端又分兩塊，**順序不能反**：

1. **資料庫** — 加欄位、塞資料
2. **程式**（Edge Function `interpret`）— 會用到上面那些新欄位

反過來的話，新程式去讀還不存在的欄位，整支會壞。

---

## 開始之前

### 打開 PowerShell，走到後端資料夾

Windows 開始鍵 → 打 `powershell` → Enter。

黑底白字的視窗跳出來後，走到後端專案的資料夾。**你要找的是「裡面有 `supabase`
和 `dev` 兩個資料夾」的那一層**：

```powershell
cd D:\cangwang
```

（路徑不對就自己改。不確定的話打 `dir` 按 Enter，看列出來的東西裡有沒有
`supabase` 和 `dev`。有，就是這裡。）

### 拿一支鑰匙

電腦要證明「我是你」才能改你的 Supabase。這支鑰匙叫存取權杖。

1. 瀏覽器開 https://supabase.com ，登入
2. 右上角頭像 → **Account**
3. 左邊選 **Access Tokens**
4. **Generate new token**，名字隨便打（例如 `deploy`）
5. 產生後只會顯示**一次**，馬上複製起來（`sbp_` 開頭的一長串）

貼進 PowerShell：

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_把你複製的貼在這裡"
```

按 Enter，**沒有任何反應是正常的**——這行只是把鑰匙先放在手邊。

> ⚠️ 這支鑰匙只在**這個視窗**有效。視窗關掉就要重設一次。
> 也不要把它貼進任何檔案或傳給別人。

### 裝一次工具

```powershell
supabase --version
```

有印出版本號就跳過下一行。出現「不是內部或外部命令」就先裝：

```powershell
npm i -g supabase
```

---

## 第 1 步 · 更新資料庫

`migrate.ps1` 在 DB 裡開了一本帳（`public._migrations`），記錄哪幾支跑過。
早期是手貼 SQL Editor，那段沒有帳——所以第一次用這支腳本時，帳是空的，
它會把**全部**列成「待套用」。這不代表它們沒跑過。

`0001_init.sql` 裡有二十幾條不可重跑的語句，真的重跑會爆。
腳本自己知道，`_migrations` 是空的時候 `-Apply` 會被它擋下來。

### 1-1 先確認哪些真的在線上

Supabase 主控台 → **SQL Editor** → 貼上 → Run：

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('case_runs','character_events','character_titles','user_character_events','ledger')
order by table_name;
```

**沒列出來的表，代表對應的 migration 從沒跑過，絕對不能列進 baseline。**
標進去就等於宣告「它已經上線了」，那支往後永遠不會再被執行。

> 2026-08 實測：`case_runs` 不存在（0039 沒跑過），其餘四張都在。

### 1-2 把「沒跑過」的那幾支先移出資料夾

baseline 會把當下資料夾裡**所有**未記錄的檔案一次標記掉，沒得挑。
所以先把要真的執行的那支搬走（搬到專案根目錄，看得見、也好搬回來）：

```powershell
Move-Item supabase\migrations\0039_case_runs.sql .
```

### 1-3 建立基準

```powershell
.\dev\migrate.ps1 -Baseline
```

會問 `確認？(yes/no)`，**打完整的 `yes`**（`y` 不算）。
這一步**不執行任何 SQL**，只是把現有的標成已套用。

### 1-4 把它搬回來

```powershell
Move-Item 0039_case_runs.sql supabase\migrations\
```

（真的弄丟了也不要緊，`git checkout -- supabase/migrations/0039_case_runs.sql` 可還原。）

### 1-5 拉最新的 migration

本機如果還停在舊 commit，新的那幾支根本不在硬碟上，套了也只會說「沒有要套用的」。

```powershell
git fetch origin
git checkout claude/check-sutra-divination-updates-c05416
git pull origin claude/check-sutra-divination-updates-c05416
```

**順序不能反：一定先 baseline、再拉新檔。** 反過來的話，
baseline 會把新的那幾支一起標成已套用卻沒真的跑，新欄位永遠不會出現。

### 1-6 看狀態

```powershell
.\dev\migrate.ps1 -Status
```

該看到 **本機 42 支、已套用 38 支、待套用 4 支**，列出 0039～0042。
數字對不上就停下來，不要往下套。

### 1-7 一支一支套

照號碼由小到大，每一支都會問 `確認？`，打 `yes`，看到 `✅ 已套用並記錄` 再跑下一支。

```powershell
.\dev\migrate.ps1 -Apply -Only 0039_case_runs.sql
.\dev\migrate.ps1 -Apply -Only 0040_case_runs_seq.sql
.\dev\migrate.ps1 -Apply -Only 0041_ledger_ref_backfill.sql
.\dev\migrate.ps1 -Apply -Only 0042_character_events_summary_and_seed.sql
```

**一次一支**——真的出事才知道是哪一支。

| | 這支在做什麼 | 不跑會怎樣 |
| --- | --- | --- |
| `0039` | 建 `case_runs`，一局卦案的存檔 | **卦案完全開不起來** |
| `0040` | 加 `seq` 欄位，擋同一局的並行寫入 | 連點兩下會蓋掉彼此的進度 |
| `0041` | 讓靈石收支明細接得回卦與貼文 | 收支頁明細點不進去 |
| `0042` | 加 `summary` 欄位，並把三章劇本寫進資料庫 | **道籍›事件會是空的** |

最後再 `-Status` 一次，四支都該變成已套用。

---

## 第 2 步 · 更新程式

```powershell
supabase functions deploy interpret --project-ref ajogafvzlhqwlxwkfcpn --no-verify-jwt
```

跑個十幾秒，最後出現 `Deployed Functions on project ...` 就是成功。

**後面那串 `--no-verify-jwt` 不能省。** `interpret` 自己驗身分，而且有兩條路：
網頁帶登入憑證進來，Telegram bot 帶另一種自訂標頭進來。少了這個旗標，
Supabase 的門口會先幫你擋一次，Telegram 那條路會被擋在門外——
而且錯誤不會出現在函式的日誌裡，很難查。

### 確認它活著

```powershell
curl.exe -s -X POST "https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/interpret" -H "Content-Type: application/json" -d '{\"mode\":\"wall\"}'
```

看到 `{"kind":"ok",...}` 開頭的一大串就對了。

---

## 第 3 步 · 前端

上面兩步都完成之後，跟我說一聲。我把分支合進 `main`，
Cloudflare 會自動把網頁版上線——解卦存圖與朗讀按鈕就回來了。

---

## 卡住的時候

把畫面上的紅字整段複製給我，不要只說「壞了」。常見的三種：

- **`不是內部或外部命令`** — 工具沒裝，回上面跑 `npm i -g supabase`
- **`401` 或 `Unauthorized`** — 鑰匙沒設或視窗換過了，重貼一次 `$env:SUPABASE_ACCESS_TOKEN`
- **函式部署後回 500** — Supabase 主控台 → Edge Functions → interpret → Logs，把日誌貼給我
- **`_migrations 是空的`** — 還沒建基準，回 1-1 起照做
- **`已有 N 筆，不需要再 baseline`** — 基準已經建過了，跳到 1-5

migration 是一支一支跑的，失敗的那支不會被記成已套用。修好再跑同一支即可，
前面成功的不會重跑。
