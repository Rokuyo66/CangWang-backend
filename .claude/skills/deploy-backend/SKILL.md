---
name: deploy-backend
description: 把已併入 main 的後端改動部署到 Supabase 正式環境（migration → Storage → Edge Function → 驗收 → 觀中誌）。只在六六說「部署」時用。
disable-model-invocation: true
---

# 部署後端（Supabase 正式環境）

supabase CLI 被 Windows App Control 封鎖、沒有 gh，所以全程走 Management API（curl）。
token 由 `dev/lib/cred.ps1` 從憑證管理員現讀，**不要印出、不要寫檔、不要貼進指令**。
以下腳本都在本 skill 的 `scripts/`，從 repo 根目錄用 `pwsh -NoProfile -File` 跑。

## 0. 前置（任一不過就停下來回報，不要硬推）

1. 改動已開 PR 並**併進 main**。部署一律從主 checkout（`D:\cangwang`）**剛 pull 完的 main** 推，絕不從 feature 分支或 worktree 推——那會把另一台機器已上線的改動抹掉。
2. 主 checkout 工作區乾淨才 `git switch main && git pull`（髒的時候 pull 曾蓋掉上游 commit）。
3. 問清楚這次要部署哪些東西：哪幾支 migration、要不要動 Storage、哪幾支 function。
   用到 `_shared/chat.ts` 的有 `interpret`、`webhook-tg`，改 chat.ts 兩支都要重部署。

## 1. 資料庫（順序不能反：先 DB，再 function）

```
pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/migrate.ps1 -Status
```
- 列出「線上有、本機沒有」的 migration ＝ 另一台機器的工作還沒併進來 → 停，回報六六。
- 套用：`'yes' | pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/migrate.ps1 -Apply -Only <檔名>`
  （一支一支套，`'yes' |` 是因為非互動環境 Read-Host 會掛）。
- `0017_reminders.sql` 永遠不跑。

## 2. Storage

只有新增 bucket 時才需要；照 `dev/deploy-howto.md` 的「檔案櫃」段落做，平常略過。

## 3. Edge Function

先 dry-run 看線上版本與時間：
```
pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/deploy-function.ps1 -Fn interpret,webhook-tg -DryRun
```
- 若線上 `updated_at` 晚於 repo 最後相關 commit，而你不知道那次部署是誰做的 → 線上可能有未併分支的程式。
  停下來，照記憶 backend-repo-stale-risk 用 eszip 解出線上原始碼比對，問過六六再繼續。
- 沒問題就拿掉 `-DryRun` 正式部署。腳本會擋：不在 main、HEAD ≠ origin/main、functions 有未 commit 改動。
  `-AllowStale` 只在六六明說時才加。

## 4. 驗收

1. 冒煙：`curl.exe -s -X POST https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/interpret -H "content-type: application/json" -d '{"mode":"wall"}'`（pwsh 7） 要回資料；需認證的 mode 不帶 JWT 要回 403。webhook-tg 不帶 secret 要被擋。
2. 整套檢查：`pwsh -NoProfile -File .claude/skills/deploy-backend/scripts/run-sql.ps1 -File dev/postdeploy-check.sql`，每列都要 ✅。有 ❌ 就回報，不要自己修線上資料。
3. 有 Supabase MCP 可用時，用 `query_logs` 看 edge-function 有沒有新的 500。

## 5. 觀中誌（只有卦理改動時）

卦理（`rules.ts`、`core.ts` 的卦理邏輯）上線後要發一則觀中誌：寫進 `changelog` 表，口吻是世界觀敘事（觀主與三位解卦人研討、多有精進、邀用戶起卦），不是乾巴巴的 changelog，也不寄 `/mail`。
**先把內文給六六看，同意後**才用 `run-sql.ps1 -Query "insert into changelog (body) values ('…')"` 寫入（單引號要寫成兩個）。

## 6. 回報

列出：套了哪些 migration、每支 function 的新版本號、postdeploy-check 結果、觀中誌有沒有發。
