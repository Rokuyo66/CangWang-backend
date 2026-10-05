# 幾知觀 · 架構地圖與後續開發落點

**開新功能之前先看這一份**：它在哪一層、放哪個檔、資料存哪張表、規範寫在哪。
做完回頭補這一份——地圖不更新，下一個人就會另開一個位置，同一件事又變成兩份。

最後整理：2026-10-05（前端 b86 之後、`part1／part2` 拆檔與 token 統一之後）

---

## 一、兩個 repo 各管什麼

| | 後端 `Rokuyo66/CangWang-backend` | 前端 `Rokuyo66/CangWang-web` |
| --- | --- | --- |
| 管什麼 | 資料、規則、AI、金流、排程；**全站美術與動態規範** | 畫面、動態、App 殼（Capacitor）、桌面小工具 |
| 程式 | `supabase/functions/interpret`（一支 Edge Function，用 `mode` 分流）＋ `_shared/*.ts` | `src/main/`（主流程）、`src/base/`（主樣式）、`src/markup/`（畫面）、`src/styles/`、各功能模組 |
| 資料 | `supabase/migrations/NNNN_*.sql`（只加不刪） | 不存資料；本機只放偏好（localStorage） |
| 規範 | `dev/design/`：`tokens.json`（唯一數字來源）、美術規範、動態規範、劇本格式 | 照規範實作；生成區由後端生成器寫入 |
| 契約 | `dev/web/*-API.md`（每個功能一份） | 照契約呼叫，一律走 `interpret` |
| 上線 | 手動：migration → Storage → `functions deploy`（`dev/deploy-howto.md`） | 網頁：進 `main` 就上（Cloudflare）；App：commit 帶 `[apk]` |

**鐵則**

1. 內容不寫死在前端：劇本、角色台詞、價目、文案一律是資料（表或後端常數），改內容不必出 APK。
2. 獎勵、扣費、解鎖一律後端判定，前端只收結果。
3. 美術與動態的數字只在 `dev/design/tokens.json`（流程見 `dev/design/README.md`）。
4. migration 只加欄位、不刪欄位；舊欄位留著當回滾的退路，觀察一段時間再議。
5. 前後端要一起上的功能：後端先 deploy，前端才上；契約寫進 `dev/web/`。

---

## 二、後端模組地圖（`supabase/functions/`）

`interpret/index.ts` 只做三件事：驗身分與版本、限流、依 `mode` 分到下表的模組。**新功能的邏輯寫進 `_shared/` 的模組，index.ts 只加一行分流。**

| 領域 | 模組（`_shared/`） | 主要 mode | 主要資料表 |
| --- | --- | --- | --- |
| 起卦與批卦 | `core.ts`（排盤，與前端同一份）、`pipeline.ts`、`rules.ts`、`dongyao.ts`、`qrefine.ts` | `refine`、（預設）批卦、`deepen`、`followup`、`history`、`cast_detail`、`review` | `casts`、`cast_claims`、`feedback` |
| 回評與反芻 | `reflect.ts` | `review` | `cast_reflections`、`reflection_rules`、`user_reading_notes`、`rule_priority` |
| 閒聊與記憶 | `chat.ts`、`rhythm.ts`、`crisis.ts`、`whereabouts.ts` | `chat`、`chat_history`、`memory_list／pin／delete`、`whereabouts`、`hall_mention` | `chat_messages`、`character_memories`、`user_character`、`reminders` |
| 道緣事件與身分 | `events.ts` | `event_list／open／progress／finish`、`char_titles`、`set_char_title`、`player_titles`、`set_player_title` | `character_events`、`user_character_events`、`character_titles`、`player_titles`、`hidden_quests` |
| 心跡（心事、月誌） | `xinji.ts` | `xinji_*` | `threads`、`thread_notes`、`monthly_reviews` |
| 語音與貼紙 | `tts.ts`、`voice.ts`、`voices.ts`、`stickers.ts` | `tts`、`voice_*`、`sticker_*` | `voice_clips`、`tts_usage`、`sticker_packs`、`stickers`、`owned_packs`、`placed_stickers` |
| 卦案 | `case*.ts`、`cases/` | `case_*` | `case_runs` |
| 收集與獎勵 | `collection.ts` | `collection`、`claim_reward`、`set_avatar`、`set_char_avatar` | `gua_collection` |
| 帳務 | `ledger.ts`、`prices.ts`、`ecpay.ts` | `lingshi_log`、`plan_list`、`buy_theme`、`subscribe_create` | `plans`、`orders`、`order_payments`、`lingshi_prices`、`model_prices` |
| 廣場與社群 | （index.ts 內） | `post_*`、`comment*`、`my_plaza`、`plaza_seen`、`report_create`、`block_*`、`wall` | `posts`、`post_comments`、`post_likes`、`plaza_notices`、`reports`、`blocks` |
| 站內信與日誌 | （index.ts 內）、`broadcast-command.ts` | `mail_*` | `mail`、`mail_state`、`changelog`、`broadcasts` |
| 日運與小工具 | `fortune.ts`、`qian60.ts`、`jieqi.ts`、`widget*.ts` | `daily_fortune`、`widget`、`signin` | — |
| 營運 | `services.ts`、`notify-admin.ts` | — | `ai_usage`、`rate_minute`、`daily_stats` |

其他 Edge Function：`due-reminder`（應期提醒，排程）、`broadcast`、`webhook-tg`（Telegram bot）。
排程（pg_cron）：`cleanup-expired-casts-weekly`、`daily-stats-snapshot`（在 migration 裡）；`due-reminder-daily`（應期提醒）**只設在線上、不在 migration 裡**——換環境會漏，待補進版控。

---

## 三、後續開發項目：放哪裡

每一項都列了「放哪」。開工時照這裡放；要放別處，先回來改這張表。

### 1. 角色事件（道緣事件）——內容擴充

| | 位置 |
| --- | --- |
| 劇本（一章一幕） | **資料**：`character_events` 表，一列一幕，`scenes`／`choices`／`rewards` 是 jsonb。格式：`dev/design/journal/EVENT-SCRIPT.md`；試演台：前端 `?preview=editor` |
| 開放條件與節點規劃 | `dev/design/journal/DAOYUAN-PLAN.md`（上線閘門、道緣門檻 0／300／500／800、小節點寄信） |
| 新的獎勵種類 | 後端 `_shared/events.ts` 的發放（冪等閘門＝`user_character_events.completed_at`）＋ `character_events.rewards` 的欄位說明；前端 `src/main/23-story.js` 的獲得彈框 |
| 新的演出效果 | 前端 `src/story/engine.js`（對話幕元件 `src/ui/scene.js`）；樣式 `src/styles/story.css`、`scene.css`；**先在動態規範補一段示範** |
| 美術 | `assets/art/`（立繪、場景，檔名即 key；規格 `assets/art/README.md`） |
| 幕間讓角色引用玩家記憶 | 規劃已寫在 `character_events.scenes` 的註解：幕與幕之間由 LLM 讀 `character_memories`。放 `_shared/events.ts`，計費走 `ledger.ts` |

### 2. 新角色

目前三位（大師兄、師妹、觀貓）**寫死在前端多處**，加第四位前要先收斂：

- 後端：`characters` 表（persona）、`_shared/chat.ts` 的方案與節奏設定、`voices.ts`（聲線）
- 前端寫死處：`src/main/10-avatars.js` 的 `CHARS`／`SEAL`／`TITLE`／`AVATARS`、`src/main/11-reading.js` 的選角、`src/pages/hall.js`、`src/ui/scene.js`
- 待做：前端改成由 `profile` 回傳角色清單（後端 `characters` 表為準），前端只留美術 key

### 3. 主線劇情（全體共通的世界線）

還沒有。與道緣事件分工見 `0037_character_events.sql` 檔頭：主線推世界、道緣推「你和他」。
預定放：後端新表 `world_events`＋`user_world_progress`（照 `character_events` 的形狀），模組 `_shared/world.ts`；前端共用 `src/story/engine.js`。

### 4. 記憶的整理與長期保存（用越久越重要）

現況（`_shared/chat.ts`）：

- 對話明細 `chat_messages`：每對角色累積超過 40 則，舊的濃縮成一則記憶、刪明細，留最近 20 則
- 記憶 `character_memories`：一則一列；注入時依方案取前 N 則（釘選優先、其餘新到舊），溢出的不刪只是不注入

用久了的問題：

1. **記憶列只增不減**：每濃縮一次多一列，重度用戶一年可達數百列；能注入的只有最新 N 則，早年的重要往事除非釘選，否則實質上被遺忘。
2. **內容會重複**：同一件事被不同次濃縮各寫一遍。
3. **人設改版時只能整批清空**（`0017_clear_char_memory`）：沒有版本，舊風格的記憶無法只清掉風格、保留事實。

預定做法（放 `_shared/memory.ts`，從 `chat.ts` 抽出來）：

| 層 | 內容 | 何時產生 |
| --- | --- | --- |
| 明細 | `chat_messages`，最近 20–40 則 | 即時 |
| 條目 | `character_memories`，一件事一則 | 滾動濃縮（現有） |
| 合輯（新） | 同一角色的舊條目按「人、事、時」合併成少數幾則，舊條目標記 `merged_into`、`archived_at`（不刪，可追溯） | 排程：每月一次，或條目數超過門檻時 |
| 年鑑（新，可選） | 每年一份「這一年你和他」，也可做成道緣小節點的信 | 年度排程 |

配套：migration 加欄位 `importance`、`merged_into`、`archived_at`、`persona_version`；注入時「釘選 → 高重要度 → 新到舊」；記憶管理頁（前端 `src/main/21-favor.js` 的回憶清單、`src/main/24-char-settings.js` 的 `openCharMemory`）顯示合輯。

### 5. 其他已知的後續項目

| 項目 | 放哪 | 備註 |
| --- | --- | --- |
| 金流正式上線 | 後端 `_shared/ecpay.ts`、`ledger.ts`；`dev/plan-gating-gaps.md` | 目前未接正式金流 |
| 方案分階補齊 | `dev/plan-gating-gaps.md` 列的那幾處 | |
| 尺寸 token 收進規範 | `dev/design/tokens.json`（見 `dev/design/README.md`「待收編」） | |
| 元件時長收進 token | 同上 | |
| 卦案併入對話幕 | 前端 `src/case/case-play.js` → `src/ui/scene.js` | CLAUDE.md「對話幕的版面」 |
| iOS | 前端 Capacitor；`android/` 對面多一個 `ios/` | 小工具要另做（WidgetKit） |

---

## 四、用戶變多會出問題的地方

依「多快會碰到」排序。

| # | 哪裡 | 會怎樣 | 怎麼處理（放哪） |
| --- | --- | --- | --- |
| 1 | **AI 成本** | 費用跟用戶數、對話長度成正比；記憶與歷史注入越長越貴 | 已有 `ai_usage` 記帳、`rate_minute` 限流、方案額度。要做：每日成本告警（`notify-admin.ts`）、注入長度上限隨記憶分層一起收斂 |
| 2 | **`ai_usage`、`tts_usage` 只增不刪** | 表持續長大，統計查詢越來越慢 | 排程把超過 N 個月的明細彙總進 `daily_stats` 後刪除（新 cron，放 migration） |
| 3 | **`interpret` 一支包 91 個 mode** | 冷啟動變慢；任何一處改動都要整支重新部署，壞一處全站停 | 量大或改動頻繁的領域（廣場、心跡、卦案）拆成獨立 Edge Function；共用驗身分與限流抽到 `_shared/gate.ts` |
| 4 | **動態頭像、場景圖、語音走 Supabase Storage 公開網址** | 流量計費、海外慢 | 前面加 CDN 快取；頭像 mp4 去音軌、壓小（另見 App 卡頓那次） |
| 5 | **廣場與站內信的群發** | 群發信、通知一次寫給全部用戶 | 現在站內信的群發是「`mail.user_id` 為空＝全站一份」＋各人已讀狀態（`mail_state`），方向正確；新的通知類功能照這個形狀做，不要逐人寫一列 |
| 6 | **檢舉與審核** | 人多了靠人工看不完 | `reports` 已有；要做：管理端列表與批次處理、AI 初篩 |
| 7 | **資料庫連線與索引** | 熱門查詢（廣場列表、卦曆、閒聊歷史）沒索引會拖垮 | 新表一律附「最常用的查詢」對應的索引（照 `character_memories_take_idx` 的寫法），寫在同一支 migration |

---

## 五、用越久會出問題的地方（單一用戶的資料變多）

| # | 哪裡 | 會怎樣 | 怎麼處理（放哪） |
| --- | --- | --- | --- |
| 1 | **卦曆只撈最近 60 卦**（`history` mode 的 `limit(60)`） | 起過 60 卦以上的人，月曆往前翻會是空的；心跡、斷線復原也吃同一支 | **優先**：`history` 加月份參數（`month: "2026-09"`）或分頁；前端 `src/main/20-calendar.js` 依月份要資料 |
| 2 | **角色記憶**（`character_memories`） | 見上面「三、4」 | 記憶分層 |
| 3 | **心跡的心事與留言**（`threads`、`thread_notes`） | 時間軸越來越長 | 待查：`xinji_timeline` 是否分頁；月誌（`monthly_reviews`）本身就是摘要，可當舊資料的入口 |
| 4 | **閒聊在前端的記憶體** | 已修：只畫最近 40 則，動態頭像只最新一則在播（2026-10-05） | 新的「會一直變長的列表」照這條做（前端 CLAUDE.md「效能」） |
| 5 | **過期未印證的卦每 90 天清掉** | 用戶以為卦會永遠留著 | 這是刻意的（準驗率數據只留有印證的）；要在卦曆或條款寫明 |
| 6 | **收藏的語音、貼紙** | Storage 用量跟著長 | 依方案給額度（`plan-gating-gaps.md`）；刪帳號已會清（`0056_delete_account`） |

---

## 六、文件放哪

| 文件 | 放哪 |
| --- | --- |
| 架構地圖與後續落點（這份） | 後端 `dev/ARCHITECTURE.md` |
| 美術與動態規範、token | 後端 `dev/design/`（入口 `dev/design/README.md`） |
| 前後端契約 | 後端 `dev/web/<功能>-API.md` |
| 功能企劃（為什麼這樣做、上線閘門） | 後端 `dev/design/<功能>/`（例：`journal/DAOYUAN-PLAN.md`） |
| 部署 | 後端 `dev/deploy-howto.md` |
| 前端開發規則 | 前端 `CLAUDE.md` |
| 前端結構與每個檔管什麼 | 前端 `README.md` |
| 前端現況、版本、更新紀錄 | 前端 `STATUS.md` |
| 效能檢查 | 前端 `dev/perf/` |
