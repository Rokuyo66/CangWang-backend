# ai-studio 現況整理（Claude 讀稿，2026-10-26）

只讀不改，整理現況給六六看。以下內容全部來自實際程式碼（`studio/*.py`、`prompts/*.md`）與
實際跑出來的資料（`claude/*.json`、`logs/studio.log`、`approved/*.json`），不是憑印象寫的。

---

## 0. 先說清楚一個容易搞混的地方

六六問的「角色事件、江湖事件、道緣信」三種，在現在的程式裡**不是三個並列的東西**：

- **道緣信**＝現行格式之一，對應 `kind_letter.md`。
- 「**江湖事件**」「**角色事件**」是**舊版**的單篇劇本格式（`prompts/writer.md` + `prompts/ideas.md` +
  `pipeline.py` 裡的 `SCRIPT_SCHEMA`／`render_script`／`html_parts`），現在已經停用：
  `cmd_ideas`（`bot.py:566`）被改成直接回覆「自由出題已停用，三種稿都有固定缺口」，
  `worker()`（`bot.py:908`）裡會把沒有 `kind` 欄位的舊任務（也就是這種舊格式）直接移進
  `rejected/`，不會真的拿去寫。`writer.md`／`ideas.md`／`SCRIPT_SCHEMA` 這些程式碼還留在
  `pipeline.py` 裡，但已經是死碼，沒有任何現役流程會呼叫到。
- 現行的「三種稿」其實是 `studio/kinds.py` 裡的三個 kind：
  - `letter`（道緣信）
  - `chapter`（道緣章，即舊「角色事件」概念的後繼，character_events 的一章）
  - `jh_outline`（江湖大綱，即舊「江湖事件」概念的後繼，但現在只寫到「大綱」層級，
    不是逐幕逐行的全篇劇本）

下面照現行三種 kind 來講「怎麼寫」。

---

## 1. 寫稿 prompt：三種稿各自怎麼寫

### 共用底稿：`prompts/bible.md`
所有寫手／審稿 prompt 開頭都會把 `{{BIBLE}}` 換成這份「幾知觀聖經速查表」，內容是：
- 通則（好感只影響話量不改人格、不寫三人群聊主場、不預演卦理推演）
- 四個角色（觀主／觀喵／大師兄／師妹）的關係、稱呼表、外貌、世界觀器物限制
- 大師兄／師妹／觀喵各自的語氣規則與「禁止清單」

這份是全專案的角色行為憲法，三種 kind 的寫手與審稿都吃這份。

### 1-1 道緣信（`letter`，prompt：`kind_letter.md`）
- 只在熟度**升階**時寄：初識→相熟（300）、相熟→相知（500）、相知→知己（800），每位角色 3 封。
- 分寸表：300 客氣有距離／500 願意提私事但克制／800 露一點真心但不告白不說永遠。
- 文體規定死：書信文言，文白相間，不用現代口語。
- 欄位：`subject`（信封一句，≤16字）、`body`（150–400字，\n分段，每段≤120字）、
  `lingshi`（夾帶靈石，依升階級距 8–25）、`memory`（第三人稱事實，≤60字，不可用「暗示／似乎」）。
- 寫手會拿到「這位角色已經寫過的信」清單（`kinds.py: Letter.user_prompt`），避免跟舊信重複物件/事件。
- 角色不知道「道緣」「點數」「靈石數量」這些遊戲詞彙，信與記憶裡都不能出現。

### 1-2 道緣章（`chapter`，prompt：`kind_chapter.md`）
- 每位角色 4 章，熟度門檻 0/300/500/800，對應 `character_events`。
- 一幕＝一次對話框，欄位：`bg`（限定 10 個場景 key，換場才寫）、`who`/`me`（說話者）、
  `text`（台詞「」+旁白\n分句）、`choices`（2–3個）、`next`/`end`（分支收合）。
- 12–24 幕，至少 1 個選擇點，最後一幕必須 `end: true`。
- 結尾會得到 `reward_title`（新身分）、`reward_memory`（記住的一件事）、
  `reward_lingshi`（依章數 10/30/50/100）。
- 劇情規定「從這位角色自己的設定長出來」，不可照抄已上線的大師兄第一章
  （`kinds.py` 裡有 `EXISTING`/`CHAPTER_HINT`/`chapter_outlines.json` 機制：
  有製作人定稿大綱就照寫，沒有就讓寫手自己提案）。

### 1-3 江湖大綱（`jh_outline`，prompt：`kind_jh_outline.md`）
- 一卦一篇：六爻＝六節，**初爻對初節、二爻對二節……上爻對上節**，這是最重要的鐵則。
- 玩家預設身分「幾知觀下山弟子」，三位主角不會死，本篇專屬 NPC 可以死。
- 結局要 4–6 個：一個稀有、一個人物死亡/重大損失、一個「看清但不出手」、一個保底。
- 若題目帶有「製作人已定的大綱」（來自 `prompts/jh_seeds.json`）：**篇名與結局方向不可改字**，
  寫手工作只是把空欄位（六節、人物、爻位對應）補齊。
- NPC id 規定格式 `n_` + 拼音小寫，且會跟 `prompts/jh_cast.json`（別卦共用人物）核對
  id/名字要一致。
- 這一種目前品質問題最嚴重，詳見第 5 節。

### 寫作時的重寫上下文
`pipeline.write()`：每次重寫會把「上一版逐行稿」「審稿意見」「製作人修改意見」一起餵給寫手，
温度第一輪用 `writer_temperature`（0.9），重寫起降到 ≤0.7。

---

## 2. 審稿標準與評分方式

審稿分三層，**都在 `pipeline.review()`**（`studio/pipeline.py:210`）：

1. **程式檢查**（`kinds.py` 各 kind 的 `.lint()`）：正規表達式等機械檢查——簡體字、
   稱呼表、「師傅」只有大師兄能說、現代器物詞彙、格式（幕數、choices 數、段落字數、
   靈石級距、NPC id 格式……）。**程式檢查沒過一樣會送模型審**（10-26 改過，避免永遠卡在格式層）。
2. **因果審**（`causality.md`，模型＝`second_reviewer_model` = `gemma4:12b`，用不同家族模型避免
   跟第一審系統性盲點重疊）：只查「因果斷裂」「憑空出現」「設定衝突」「秘密曝光」四類。
3. **口吻審**（`reviewer.md`，模型＝`reviewer_model` = `qwen3.5:35b-a3b`，`reviewer_think: false`）：
   查稱呼、秘密曝光、角色 OOC、禁用模式（全知旁白、大師兄「不是A而是B」句式…）、卦理生剋、文筆。

兩個模型審稿都**只列問題**（`issues: [{type, where, detail, fix}]`），不自己打分；
`score_review()`（`pipeline.py:109`）去重後用固定扣分表算分：

| 問題類型 | 扣分 | 備註 |
|---|---|---|
| 稱呼存疑 | 0 | 模型自己懷疑但程式沒核實到，不算數 |
| 稱呼錯誤／秘密曝光／卦理錯誤 | 25 | 這三類也是 `hard_fail`（硬傷，不論分數直接退） |
| 角色OOC／因果斷裂／設定衝突 | 10 | |
| 禁用模式 | 8 | |
| 文筆／格式 | 3 | |

`passed(cfg, rv)`：`score >= pass_score(90)` **且** 沒有硬傷，才算本地過審。

---

## 3. Telegram 機器人流程：出稿 → 審稿 → 通過，每步用什麼模型

```
① 排稿（手機點缺口按鈕 / TG 指令 /letter /chapter /jianghu）
   → queue/
② worker() 撿起來 → work/
   寫手：writer_model（現在設定是 qwen3.5:35b-a3b，之前有一段時間是 qwen3.5:9b）
③ review()：
   因果審：second_reviewer_model = gemma4:12b
   口吻審：reviewer_model = qwen3.5:35b-a3b（reviewer_think=false，不開思考模式）
④ 本地分數 < 90 或有硬傷 → 退回 queue/ 重寫（最多 max_rounds=3 輪才會真的卡住判斷；
   但實際上 round_cap=12、format_stall=4 才是真正的「卡住」門檻，見 process()）
⑤ 本地分數 ≥ 90 → 移到 claude/，推播「本地 X 分，送 Claude 複審」
⑥ 卡住（連續 4 輪都是同一種程式硬傷，或改了 12 輪還沒過）→ 一樣移到 claude/，
   但標記 stuck: "format" 或 "rounds"，交 Claude 診斷而不是走正常複審
⑦ Claude 複審（`studio/sync.py: verdict`，人工執行，不是自動）：
   ≥95 分 → pending/，TG 推播給六六按 ✅通過／↩️退回／🗑捨棄
   <95 分 → 帶 Claude 的意見排回 queue/ 最前面重寫
⑧ 六六在 TG 按「✅ 通過」→ approved/
⑨ approved 的稿由 Claude（人工跑 `studio.sync`）同步進「企劃工作臺」
   （claude.ai 的一份 Artifact 文件，規格見 SYNC.md）
```

**本地助理**（`studio/agent.py`，六六直接在 TG 打字時）另外用 `agent_model`
（沒設就退回 `writer_model`）做工具呼叫（排稿、查狀態、暫停/恢復），跟寫稿/審稿的模型分開。

---

## 4. 通過的稿現在存在哪裡、什麼格式

- **`approved/*.json`**：六六在 TG 按「通過」之後的最終檔，是**任務檔**（task），不是劇本本身。
  結構：`{id, brief, kind, meta, slot, rounds:[{n, at, script, review, secs, models, ...}], ...}`。
  真正的劇本內容在 `rounds[-1]["script"]`，是**符合 kinds.py schema 的 JSON**
  （letter → subject/body/lingshi/memory；chapter → title/scenes/reward_*；
  jh_outline → title/tone/outline/identity/npcs）。
- **這些 approved 的稿還沒有進 cangwang 正式 repo**：`SYNC.md` 說得很清楚——Claude 要用
  `python3 -m studio.sync pending` 把它轉成「工作臺格式」（`sync.py: to_doc()`），
  寫進 **claude.ai 的工作臺 Artifact**（`col/doc_id`，例如 `letters/daoshi_m_t500`），
  六六在工作臺上再做最後編修，**真正要進遊戲**還要再經過一次六六或 Claude 從工作臺匯出到
  正式的 `cangwang` repo（這一步不在 ai-studio 範圍內，ai-studio 本身「不部署、不動 repo」，
  見 `SYNC.md` 最後一條規則）。
- **人看的唯讀版本**：`讀稿/` 資料夾（`studio/export.py`，每分鐘跑一次），按格式分子資料夾
  （道緣信／道緣章／江湖大綱），檔名用角色/卦號+標題，內容是 Markdown＋最後一輪審稿意見，
  外加 `讀稿/總表.md` 彙總表。這個資料夾涵蓋 pending/claude/approved/work/queue 五個階段，
  approved 只是其中一種狀態標記，不是只有 approved 才會進讀稿。

---

## 5. 目前卡住或品質不好的地方（從 `claude/*.json` 與 `logs/studio.log` 看出來的）

### 5-1 江湖大綱（jh_outline）是目前品質最差、最常卡住的一種
`claude/` 資料夾現在 7 份裡有 3 份是 jh_outline／letter 卡在 `stuck` 狀態，另外像
`1026-015113-6375`（第7卦 地水師，目前還在 `work/` 跑）在今天（10-26）單一任務已經寫到
**第 23–24 輪**，分數在 0 分與 70–100 分之間劇烈震盪（見 `state.json` 與 `studio.log`）：

```
第22輪：10分｜硬傷｜因果斷裂、設定衝突、因果斷裂→重寫
第23輪：42分｜硬傷｜因果斷裂、設定衝突、稱呼存疑→重寫
```

同樣的震盪模式在好幾份 jh_outline／letter 任務裡重複出現（`1026-013921-b77b`、
`1026-015059-7b44`、`1026-015105-ccd8`、`1026-015110-12d9`），**共通特徵**：
- 審稿意見每一輪都不一樣：這輪被挑「卦理錯誤」改掉，下一輪因果審又挑出新的「因果斷裂」，
  改完因果審滿意了，口吻審又挑出「角色OOC」——**修正是來回拉扯，不是收斂**。
  例如 `1026-015110-12d9`（第5卦 水天需）n=4 時因果審打 12 分，n=5 改完因果後，
  口吻審反過來把 n=4 版本裡「已經按因果審意見改好」的爻辭解讀打成「卦理錯誤」，
  整個 0 分，兩邊審稿標準互相矛盾、拉扯了至少 8 輪才穩定。
- `round_cap=12` 實際上**攔不住**：`sync.verdict()`／`sync.reject()` 每次把任務從 `claude/`
  退回重寫時會 `cap_base = len(rounds)`（`sync.py:94`／`:132`），等於把輪數計數器歸零重算，
  所以一份稿可以被 Claude 退回好幾次、每次都重新獲得 12 輪額度，實際總輪數遠超過
  `round_cap`（地水師那份已經 24 輪）。這是設計上的漏洞，不是目前這份稿特別難寫。

### 5-2 9b 寫手模型在「角色稱呼」上系統性出錯，已被手動換掉
`1025-214614-1c74`（大師兄的信・相熟→相知）是個很乾淨的對照組：
第 1–13 輪 `writer` 都是 `qwen3.5:9b`，分數在 0–80 分之間反覆橫跳，
主因幾乎都是同一件事——大師兄對玩家的稱呼在「護道人」「師妹」「施主」之間亂跳
（正確答案固定是「護道人」），外加好幾輪被挑「秘密曝光」（暗示師傅=觀喵）、
「角色OOC」（寫出大師兄禁止的「不是A而是B」句式、描述自己情緒）。
**第 14 輪 `writer` 換成 `qwen3.5:35b-a3b` 之後一次就 100 分過關**。
`config.json` 現在的 `writer_model` 已經是 `qwen3.5:35b-a3b`（跟 `reviewer_model` 同一顆），
研判是六六或 Claude 已經發現 9b 寫手在角色口吻上不夠穩，手動升級了——但 `claude/` 裡
還留著好幾份用 9b 寫到一半、卡在稱呼/秘密曝光反覆橫跳的舊任務歷史，可以當作升級前後對照。

### 5-3 審稿模型開思考模式時會「鬼打牆」輸出不完整 JSON（已修，但留了痕跡）
`logs/bad-審稿-*.txt`（4 份，10-25 當天）：`done_reason=length tokens=8192`，
審稿模型的 `thinking` 內容把整個 8192 token 額度耗光，正文 JSON 根本沒輸出。
現在 `config.json` 的 `reviewer_think: false` 已經關掉思考模式，`pipeline._json_call()`
也有「重試時強制 think=False」的保護，這個問題目前看起來已經處理掉，只是舊 log 還在。

### 5-4 舊格式「角色事件/江湖事件」的 bad log 側面印證了格式改版的原因
`logs/bad-寫稿-*.txt`（1 份）是舊 `SCRIPT_SCHEMA`（`kind: 角色事件`）寫到 `done_reason=length`
（4096 token 用完還沒寫完一篇），這類「一次寫一整篇逐幕逐行劇本」的舊格式容易爆 token、
格式跑飛，可能正是後來拆成「先只寫大綱（jh_outline）／先用模板化的一幕一欄位（chapter）」
的原因之一（屬於推測，程式碼裡沒有明講，但跟現在的改版方向吻合）。

### 5-5 現況快照（10-26 本次讀稿當下）
`queue` 5 份／`work` 1 份／`pending` 0 份／`claude` 7 份（含 3 份 `stuck`）／
`approved` 4 份／`rejected` 21 份／`讀稿/` 已輸出 18 份 md。
`rejected` 21 份偏多，大部分是舊格式任務被 `worker()` 自動清掉（見 5-4），
不完全代表「寫壞被丟棄」。

---

## 小結（給六六看的重點）

1. 「江湖事件／角色事件」這個講法已經過時，現在是 letter／chapter／jh_outline 三個 kind。
2. jh_outline 的因果審／口吻審標準會互相打架，同一卦常常卡 15–24 輪都收斂不了，
   `round_cap` 因為 Claude 退回會歸零而形同虛設，這是最值得优先修的流程漏洞。
3. 9b 寫手在稱呼與角色 OOC 上明顯比 35b-a3b 弱，換模型後問題消失，現在 config 已經是
   35b-a3b，算是已經處理過的舊問題。
4. 審稿思考模式（`reviewer_think`）開著會鬼打牆，現在已關閉。
5. approved 只是「六六在 TG 按過通過」，還沒有真的進 cangwang 正式 repo，
   中間要經過工作臺（claude.ai Artifact）這一站。
