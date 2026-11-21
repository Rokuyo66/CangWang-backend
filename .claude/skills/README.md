# Project skills

| Skill | Source | Notes |
|---|---|---|
| `grill-me` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/productivity/grill-me` @ a496f55 | User-invoked only (`/grill-me`). Delegates to `grilling`. |
| `grilling` | [mattpocock/skills](https://github.com/mattpocock/skills) `skills/productivity/grilling` @ a496f55 | Interviews you round by round over a design tree until the plan is fully specified. |
| `deploy-backend` | 本 repo | User-invoked only (`/deploy-backend`). Management API 部署：migration → Storage → Edge Function → postdeploy-check → 觀中誌。腳本在 `scripts/`，token 走 `dev/lib/cred.ps1`。 |
| `open-pr` | 本 repo | User-invoked only (`/open-pr`). 沒有 gh 時用 `scripts/gh-api.mjs` 開／併 PR、刪分支。 |

`grill-me`／`grilling` are MIT licensed (see each folder's `LICENSE`). Update by re-copying `SKILL.md` from upstream.

## Hooks 與 MCP（不在這個資料夾，但一起看）

- Hooks 設在 `.claude/settings.json`，腳本在 `dev/hooks/`：開工同步檢查（SessionStart）、migration 守門與金鑰守門（PreToolUse）、TS 語法檢查（PostToolUse）。
- Supabase MCP（唯讀）啟動器在 `dev/mcp/supabase-mcp.ps1`；`.mcp.json` 只留本機，接法見該檔註解。
