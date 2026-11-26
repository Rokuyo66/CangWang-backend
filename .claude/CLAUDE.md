# 動前端畫面之前（硬規則）

本 repo 的 session 不會自動載入前端 repo 的 CLAUDE.md。只要要寫或改 `CangWang-web`（含它的 worktree，如 `D:/CangWang-web-*`）裡任何看得見的東西——HTML、CSS、版面、獨立頁、圖示、小工具示意圖——**先讀這兩份，再動手**：

1. `D:/CangWang-web/CLAUDE.md` 的「〇、美術規範是唯一依據」整節
2. 本 repo 的 `dev/design/README.md`（設計 token 的唯一來源是 `dev/design/tokens.json`；前端 CSS 裡 `@design:begin … @design:end` 是生成區，不准手抄、不准手改）

色碼、按鈕、主題、圖示、小工具外觀一律從規範與現成生成檔取，不自己發明。使用者層的 `design-gate` hook 會在沒讀過規範時擋下 Write／Edit；用 Bash 改檔會繞過它，所以同樣遵守。

# 模型分工

- 主會話（Sonnet）：寫碼與決策。難題交給 advisor（Opus）。
- 子代理（Haiku）：搜尋、找調用點、審查與測試。

## 子代理委派（保持主上下文小）

門檻：預估要讀 **3 個檔以上**，或不知道目標在哪 → 委派；否則主會話直接做。

- 找結構、找位置 → `search`；找調用點、找引用 → `grep`。
- 測試一律交給 `audit`（worktree 隔離，不受門檻限制），且要在 commit **之前**跑：
  先執行 `git diff HEAD > <暫存目錄>/audit.patch`（暫存目錄須在 repo 之外），
  再把 `git rev-parse HEAD` 的 SHA 和 patch 絕對路徑一起交給 audit。
- 子代理只回結論（`路徑:行號`＋一句話）；主會話不重讀它們已讀過的檔。
- 已知確切路徑的單一檔案，主會話直接 Read。
