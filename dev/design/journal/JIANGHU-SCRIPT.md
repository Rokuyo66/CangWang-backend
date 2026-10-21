# 江湖事件 · 劇本格式 v2（2026-10-21）

稿紙：`dev/design/journal/sheet.html` 的「江湖事件」分頁（發佈在「道緣劇本稿紙」artifact；雲端存檔 `jianghu/gua_01…gua_64`、共用設定 `jianghu_cfg/main`）。
**後端與 App 還沒接**：這份是稿紙存的格式，也是之後建表、寫執行邏輯的依據。
v1（事件池＋隨機抽）作廢；起點是六六與 GPT 討論的〈江湖事件編輯器需求規格〉與〈六十四卦事件大綱〉，取捨見最後一節。

## 定案的玩法

| | 規則 |
|---|---|
| 一卦一篇 | 玩家**今天的日運卦是哪一卦，今天的江湖就是那一篇**。64 篇＝成就榜 64 格（同卦鑑的 8×8） |
| 六爻＝六節 | 一篇依序演初爻→上爻六節。日運卦**哪一爻是動爻，那一節多演「變數」幾幕**；沒有動爻就照常走 |
| 長度 | 一趟 5～10 分鐘 |
| 次數 | 每天免費一趟；再走要靈石；同一天重走還是同一卦（同選擇＝同一條路） |
| 主角 | 玩家。預設身分「幾知觀下山的弟子」；不好編才用偽裝身分。入場選**本名或化名**（化名規則在 `jianghu_cfg`） |
| 生死 | **玩家與三位不會死**。本篇專屬人物可以，某些結局寫死也行——讓人想再走一次找救下他的路 |
| 三位 | 可客串（例：回觀求助），不改變他們和玩家的關係；不求助也要走得完 |
| 調性 | 江湖小事為主，可標「重口」 |
| 數值 | 全江湖共用四項（`jianghu_cfg.stats`，預設 義／明／勢／緣，草案），每篇不自己發明；玩家看不到數字 |
| 結局 | 由上往下比、最後一個保底；每個結局一句領悟、可發稱號、第一次達成給靈石、可留懸念引去談心（寫進那位記憶） |
| 成就 | 每卦一個，綁一個結局；第一次走到那個結局時亮起 |
| 生成 | 大綱寫好把狀態改「請生成」，Claude 從雲端存檔讀走、寫初稿回同一份；六六在稿紙潤飾、試走 |

## 一篇（jianghu/gua_NN）

```jsonc
{
  "id": "gua_05", "gua_no": 5, "gua": "水天需", "title": "雨夜待援",
  "status": "draft",                    // draft 草稿｜gen 請生成｜review 待看｜final 定稿｜temp 暫用｜archived 封存
  "tone": "small",                      // small 江湖小事｜heavy 重口
  "outline": { "theme", "summary", "player_summary", "core_question", "conflict", "player_role",
               "plot", "ending_dirs", "achievement_dir", "must_include", "must_avoid", "source_notes" },
  "identity": { "mode": "disciple", "label": "", "reason": "" },    // mode: disciple｜disguise
  "npcs": [{ "id": "sxxxx", "name": "姚幫主", "desc": "一句設定" }],
  "opening": { "bg": "", "text": "雨下了三天，{名}被困在半山的莊子裡。" },   // {名}＝玩家選的本名或化名
  "nodes": [                            // 恰好 6 個：nodes[0]＝初爻 … nodes[5]＝上爻
    { "title": "", "scenes": [ /* 幕 */ ], "change": { "scenes": [ /* 動爻時多演的幕；空＝這一節沒有變數 */ ] } }
  ],
  "endings": [ /* 結局 */ ],
  "achievements": [                      // 一卦可以好幾個；亮了之後玩家在 App「道籍 › 成就」自己點領取
    { "id": "qun", "name": "見群龍无首", "desc": "玩家看得到的提示", "kind": "ending", "ending": "<結局 id>", "reward_lingshi": 30 }
  ],
  "achievement": { "name": "雨過天青", "desc": "", "ending": "<結局 id>" }   // 舊格式（只綁結局），稿紙自動跟 achievements 同步
}
```

### 幕
同角色事件（EVENT-SCRIPT.md）：`who`（三位）／`me`／`speaker`＋`npc`（本篇人物 id）／`portrait`／`text`／`end`／`choices`。
選項：`{ key, label, hint?, fx?: { s1: 1 }, get?: "道具", req?: "道具", set?: "旗標", to?: "<同一節內的幕 id>" | "end" }`。
`to: "end"`＝這一節結束（往下一節，或先演這一節的變數）。
`set`＝暗旗標：玩家看不到，只給結局判斷用。數值只能說「傾向」，旗標記的是「做了哪件事」——例：乾為天上爻喊「上去！」設 `登柱`，結局就一定是墜柱，不會因為前面義氣高而跑去喜劇收尾。

場景 `bg`：`guanmen`（觀門）、`kezhan`（山下客棧）、`dukou`（渡口）、`leitai`（擂台）、`longzhu`（龍柱）、`wanjin`（萬金號）＋角色事件那幾張。
後四張還沒有圖：App 先借舊圖（前端 `story/engine.js` 的 `BG_BORROW`），稿紙「美術需求」頁列著要畫什麼；圖到了放進 `scene/<key>` 就自動換過去。

### 結局
`{ id, title, rare, need: { s1: [下限|null, 上限|null] }, flags: ["要有的旗標"], not_flags: ["不能有的旗標"], text, insight, npc_fate, reward_lingshi, player_title: { label, desc, call_as }, hook: { who, ask, memory } | null }`

### 成就
`kind` 四種（後端 `_shared/jianghu.ts` 的 `litAchievements`）：

| kind | 什麼時候亮 |
|---|---|
| `ending` | 走到 `ending` 那個結局 |
| `endings_all` | 這一卦所有結局都走過（累計） |
| `changes_all` | 有變數幕的爻，每一爻的變數都演過（累計；動爻靠運氣，再走一趟會重搖） |
| `items_all` | 一趟之內，劇本裡所有道具都帶在身上 |

## 上線：稿紙 → App
1. 稿紙存好（Claude 讀雲端 `jianghu/gua_NN`）→ 存成 `dev/design/journal/jianghu/gua_NN.json`
2. `node dev/jianghu-seed.mjs > supabase/migrations/00xx_jianghu_<名>.sql`，跑 migration（status 是 review／temp／final 的才上架）
3. 後端照劇本重演判結局：客戶端只送每個選擇點的 key（`jh_finish`），結局表與成就條件不下發
4. `node dev/jianghu-test.mts`：乾為天六條路線、成就、亂送 key 的檢查

App 端：`src/pages/jianghu.js`（入口、演出、結局卡、成就榜）。資料表：`0092_jianghu.sql`
（每天第一趟免費、動爻照日運卦；再走一趟扣 `jianghu_config.replay_cost`、動爻重搖；第一次走到的結局發靈石＋稱號＋寫記憶）。

## 共用設定（jianghu_cfg/main）
`stats: [{ k: "s1"…"s4", name, desc }]`（k 固定，改名不影響已寫的選項）；化名：`surnames`、`compound`（一成機會）、`given1`、`given2`（兩成機會只取第二字當單名）。

## 一趟怎麼跑（稿紙「試走一趟」照這個做；後端之後也照這個）
1. 取玩家今天的日運卦：本卦決定是哪一篇，動爻決定哪幾節有變數。玩家選本名或化名（化名以「日期＋卦＋玩家」當種子，同一天固定）。
2. 數值歸零、道具清空，演開場。
3. 初爻到上爻依序：演那一節的幕（`req` 不在手上的選項不顯示；選了：`fx` 加數值、`get` 進道具、`to` 跳幕或結束這一節）；這一爻是動爻、且有變數幕，就接著演變數；選了有 `set` 的選項就記下旗標。
4. 六節演完由上往下比結局表（`need` 與 `flags`／`not_flags` 都要過；最後一個留空當保底）→ 第一次走到才發稱號、靈石、成就；有 `hook` 就寫記憶、談心掛「去問」。

## 從 GPT 規格取捨了什麼
| 採用 | 先不做（之後真的需要再加） |
|---|---|
| 一卦一篇、大綱欄位、保底結局、成就綁結局、本篇人物、回觀求助的客串、試玩可重現、發佈前檢查 | 任意節點圖（改用六爻六節）、巢狀且／或／非條件、乘法效果、冷卻與延後觸發、關係值、三種範圍的旗標（只做單篇內的暗旗標）、隨機身分池（改成單一偽裝身分）、頁面內 AI 局部重生與差異比對（改成 Claude 讀寫雲端存檔） |

## 範本
`gua_01` 乾為天「龍不歸淵」（2026-10-21，Claude 初稿）：六節、六個結局（含一個稀有、一個 NPC 死亡）、六個變數、六個道具、四個旗標、四個成就（見群龍无首／時乘六龍／六位時成／品物流形）。寫新篇先照它的密度：主線約 2500 字、8 處選擇。
