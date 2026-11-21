---
name: open-pr
description: 沒有 gh CLI 時，把目前分支推上 GitHub 並開 PR（CangWang-backend 或 CangWang-web）；六六明說才合併、刪分支。
disable-model-invocation: true
---

# 開 PR（GitHub REST API，不用 gh）

兩台機器都沒有 gh。`git push` 直接用憑證管理員裡的 GitHub 憑證；開／併 PR 用
`scripts/gh-api.mjs`（token 從 `git credential fill` 現拿，不印出）。

## 步驟

1. **確認狀態**：`git status`、`git log --oneline origin/main..HEAD`。不在 main 上（在 main 就先開分支）。
   commit 前的測試照 CLAUDE.md 交給 audit；還沒跑就先跑。
2. **推分支**：`git push -u origin <branch>`。
3. **寫 PR 說明**到暫存檔（放 repo 外，例如 scratchpad）：
   - 標題：中文一句話講改了什麼。
   - 內文：為什麼改、改了哪些檔、怎麼驗證的、部署注意事項（有沒有 migration、哪幾支 function 要重部署）。
   - 結尾附：`🤖 Generated with [Claude Code](https://claude.com/claude-code)`
4. **開 PR**：
   ```
   node .claude/skills/open-pr/scripts/gh-api.mjs open --repo CangWang-backend --head <branch> --title "<標題>" --body-file <暫存檔>
   ```
   前端 repo 用 `--repo CangWang-web`。印出的網址回報給六六。
5. **合併與刪分支只在六六明說時做**：
   ```
   node .claude/skills/open-pr/scripts/gh-api.mjs view   --repo CangWang-backend --number <n>
   node .claude/skills/open-pr/scripts/gh-api.mjs merge  --repo CangWang-backend --number <n>
   node .claude/skills/open-pr/scripts/gh-api.mjs delete-branch --repo CangWang-backend --head <branch>
   ```
   合併後要部署的話，接 `/deploy-backend`（從主 checkout 的 main pull 完再推）。

正式站（前端）：https://cangwang-web.pages.dev/ ，併進 main 後 Cloudflare 自動部署。
