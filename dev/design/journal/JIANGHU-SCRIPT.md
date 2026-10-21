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
  "achievement": { "name": "雨過天青", "desc": "玩家看得到的說明", "ending": "<結局 id>" }
}
```

### 幕
同角色事件（EVENT-SCRIPT.md）：`who`（三位）／`me`／`speaker`＋`npc`（本篇人物 id）／`portrait`／`text`／`end`／`choices`。
選項：`{ key, label, hint?, fx?: { s1: 1 }, get?: "道具", req?: "道具", to?: "<同一節內的幕 id>" | "end" }`。
`to: "end"`＝這一節結束（往下一節，或先演這一節的變數）。

### 結局
`{ id, title, rare, need: { s1: [下限|null, 上限|null] }, text, insight, npc_fate, reward_lingshi, player_title: { label, desc, call_as }, hook: { who, ask, memory } | null }`

## 共用設定（jianghu_cfg/main）
`stats: [{ k: "s1"…"s4", name, desc }]`（k 固定，改名不影響已寫的選項）；化名：`surnames`、`compound`（一成機會）、`given1`、`given2`（兩成機會只取第二字當單名）。

## 一趟怎麼跑（稿紙「試走一趟」照這個做；後端之後也照這個）
1. 取玩家今天的日運卦：本卦決定是哪一篇，動爻決定哪幾節有變數。玩家選本名或化名（化名以「日期＋卦＋玩家」當種子，同一天固定）。
2. 數值歸零、道具清空，演開場。
3. 初爻到上爻依序：演那一節的幕（`req` 不在手上的選項不顯示；選了：`fx` 加數值、`get` 進道具、`to` 跳幕或結束這一節）；這一爻是動爻、且有變數幕，就接著演變數。
4. 六節演完比結局表 → 第一次走到才發稱號、靈石、成就；有 `hook` 就寫記憶、談心掛「去問」。

## 從 GPT 規格取捨了什麼
| 採用 | 先不做（之後真的需要再加） |
|---|---|
| 一卦一篇、大綱欄位、保底結局、成就綁結局、本篇人物、回觀求助的客串、試玩可重現、發佈前檢查 | 任意節點圖（改用六爻六節）、巢狀且／或／非條件、乘法效果、冷卻與延後觸發、關係值、三種範圍的旗標、隨機身分池（改成單一偽裝身分）、頁面內 AI 局部重生與差異比對（改成 Claude 讀寫雲端存檔） |
