# ai-studio｜幾知觀夜間寫手台

本地模型夜間寫劇本、審稿，手機 TG 監控與審核，通過的稿交給 Claude 終審。

## 流程
題目（TG 傳文字 / `/ideas`）→ `queue/` → 寫手 qwen3.5:9b → 審稿 qwen3.5:35b-a3b（思考模式，JSON 打分）
→ 未過自動重寫（最多 3 輪）→ `pending/` + TG 推播 → 你按 ✅ → `approved/` → Claude 終審實裝

## 資料夾
| 資料夾 | 內容 |
|---|---|
| queue / work | 等待中 / 正在跑 |
| pending | 等你在 TG 審 |
| approved | 你通過，等 Claude 終審 |
| rejected | 捨棄或連續失敗 |
| prompts | bible.md 速查表、writer/reviewer/ideas 提示詞（改了下一份就生效，免重啟） |
| logs | studio.log |

## 常用調整（config.json，改完 `sudo systemctl restart ai-studio`）
- `active_hours`：工作時段，預設 00:00–09:00（白天讓顯卡給 ComfyUI）。`null` = 全天
- `pass_score` / `max_rounds`：過審分數與重寫上限
- `reviewer_model`：審稿模型

## 維運
```
systemctl status ai-studio
journalctl -u ai-studio -f
sudo systemctl restart ai-studio
```
