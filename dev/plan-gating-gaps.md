# 玉牒還沒吃到的地方

盤點時間：2026-08。起因是看 `dev/yudie.ps1` 印出來的九列額度表時發現——
表上有的都分階了，**表上沒有的那些也該分階，但現在是一視同仁**。

不急著推版本，這裡先記著，下次動訂閱價值的時候一起處理。

## 已經照方案分階（沒問題）

`supabase/functions/_shared/services.ts` 裡這幾組，四階各一個數字：

| 常數 | 是什麼 |
| --- | --- |
| `PLAN_CASTS` | 每日免費起卦 |
| `PLAN_FOLLOWUPS` | 每日免費追問 |
| `PLAN_CHATS` | 每日免費閒聊 |
| `PLAN_MEMORIES` | 共憶注入則數 |
| `PLAN_TURNS` | 注入對話輪數 |
| `PLAN_PINS` | 可釘選回憶 |
| `PLAN_THREADS` | 心跡同時在記（`_shared/xinji.ts`） |
| `PLAN_CLIPS` | 語音收藏段數（`_shared/voice.ts`） |

另外這幾條也是看方案的：`keptQuota`（卦案記憶檔案）、月誌卷首語的生成鎖、
全站每日總量上限。

## 沒吃到方案的

### ~~1. 朗讀字數 `DAILY_CHARS`~~ ✅ 2026-08 補上了

原本：`_shared/tts.ts` 每日 12,000 字，四階同一個數字，環境變數改的是所有人。
語音收藏段數分了四階，產生語音的字數卻沒分——擋住了「能留幾段」，
沒擋住真正在花錢的那一端。每人每月的天花板是 360,000 字 ≈ NT$1,116，
而免費帳號跟藏往一樣多。

現在：`PLAN_TTS_CHARS` 以**月**為單位分階（5,000 / 12,000 / 30,000 / 60,000），
下個月一號重來、不滾存。日上限保留成煞車（月額度的四分之一，下限 3,000），
擋的是跑掉的迴圈，不是正常使用。順手修掉一個已經在線上的 bug：
`tts_usage.day` 以前寫 UTC 日期，等於每日額度在台北時間早上八點才重置。

還沒做的：`MINIMAX_TTS_MODEL` 換成 turbo 可以再省 40%（US$60 vs 100／百萬字），
這是環境變數，不必改程式。要先聽聽看那幾把嗓子差多少。

另外，四階的字數是**用估的批文長度**（`CHARS_PER_READING = 1300`）訂的，
還沒拿線上資料校準過。量法：

```sql
select round(avg(length(coalesce(question,'') || coalesce(reading,'')))) as 平均字數,
       round(max(length(coalesce(question,'') || coalesce(reading,'')))) as 最長
from casts where coalesce(category,'') <> '日運' and reading is not null;
```

量出來差很多的話，改 `CHARS_PER_READING` 與那四個數字即可，程式不必動。

### 2. 五個靈石價目 `COST_*`

`_shared/services.ts`（`COST_CHAT` 在 `_shared/chat.ts`，可用環境變數 `LINGSHI_PER_CHAT` 整站改）：

| 常數 | 現值 | 什麼動作 |
| --- | --- | --- |
| `COST_FOLLOWUP` | 8 | 免費追問用完後，再追問一次 |
| `COST_EXTRA_CAST` | 10 | 免費起卦用完後，再起一卦 |
| `COST_DEEPEN` | 15 | 深論 |
| `COST_COMMENT` | 5 | 角色點評 |
| `COST_CHAT` | 1 | 免費閒聊用完後，一則 |

這五個對每一階收一樣的靈石。持牒的人「免費額度比較多」，但**超出額度之後
單價一樣**——牒沒有讓他買得比較便宜，只是讓他晚一點開始買。

從訂閱 CP 值的角度，這是最容易被感覺到的一塊：使用者會發現「我付了錢，
超額還是原價」。建議至少讓 `COST_FOLLOWUP` / `COST_EXTRA_CAST` 隨階打折
（例如 free 原價、觀微 -20%、知幾 -35%、藏往 -50%），折扣本身就是續訂理由。

## 順帶一提：金流還沒接

`profiles.plan` 全站沒有任何一行程式會寫（0030 只加了欄位）。線上每個帳號
永遠是 free，只有 `dev/yudie.ps1` 能撥。上面兩項補完之後，測「持牒與不持牒
差在哪」還是得靠那支。
