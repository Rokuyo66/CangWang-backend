# 成就榜：問事、道緣（0106，2026-10-23）

道籍 › 成就 有三格：**問事**、江湖、**道緣**。江湖照舊走 `jh_board`／`jh_claim`（一卦一份，寫在劇本裡）；
問事與道緣是全站一份，規則寫在 `supabase/functions/_shared/achievements.ts` 的 `ACH`。加一個成就＝加一列，`id` 上線後不要改。

## 起卦要多送兩個欄位

`interpret`（起卦那一支）：

| 欄位 | 值 | 誰送 |
| --- | --- | --- |
| `cast_via` | `chat`（談心帶過來的題）｜`agenda`（問事頁「從行程起題」或小工具點行程） | 前端 `castVia`（`src/main/02-ask.js`），清空問句或起過一卦就失效 |
| `cast_method` | `coin`｜`num`（報三數）｜`manual`（手動排盤） | 前端 `mode` |

存進 `casts.cast_via`／`cast_method`，同時 `ach_bump` 記進 `ach_progress`（只增不減；卦被清、被刪都不倒退）。日運卦不算。
回評第一次成立也記一次 `review`。

## `ach_board`

```json
{ "kind": "ok", "items": [
  { "id": "ask_10", "cat": "ask", "name": "十朋之龜", "desc": "…", "reward": 20, "state": "locked", "have": 7, "need": 10 },
  { "id": "dy_daoshi_m", "cat": "dy", "name": "麗澤", "desc": "…", "reward": 30, "state": "lit" }
] }
```

`state`：`locked`｜`lit`（可領）｜`claimed`。次數超過 1 的帶 `have`／`need`。表還沒建時回 `{ kind:"err" }`。

## `ach_claim` `{ ach_id }`

`{ kind:"ok", amount, balance }`；沒亮、領過、查無都是 `{ kind:"err", msg }`。靈石記在 ledger 的 `ach`（收支頁顯示「成就」）。

## profile 多一個 `achLit`

亮著還沒領的數。前端拿來點道籍格（`tabMeDot`）與道籍裡「成就」頁籤（`achTabDot`）的紅點。

## 目前的表

| id | 名 | 條件 | 💎 |
| --- | --- | --- | --- |
| ask_1 | 初筮 | 問過 1 卦 | 10 |
| ask_5 | 履霜 | 5 卦 | 15 |
| ask_10 | 十朋之龜 | 10 卦 | 20 |
| ask_20 | 積小高大 | 20 卦 | 30 |
| ask_30 | 恆其德 | 30 卦 | 40 |
| ask_50 | 大衍 | 50 卦 | 60 |
| ask_100 | 百慮一致 | 100 卦 | 100 |
| via_chat | 感而遂通 | 第一次從談心起卦 | 10 |
| via_agenda | 與時偕行 | 第一次從行程起卦 | 10 |
| method_num | 參伍以變 | 第一次報三數 | 10 |
| method_manual | 觀象玩辭 | 第一次手動排盤 | 10 |
| review_1 | 彰往察來 | 第一次回評應期 | 10 |
| dy_daoshi_m | 麗澤 | 大師兄的角色事件完成任一則 | 30 |

回填（0106 跑的時候）：現存的卦算進問卦數（已被清掉的找不回來）、`question_source = chat_draft` 的卦算「從談心起卦」、已回評的算進回評。
行程、報三數、手動排盤沒有舊資料可補，從上線後起算。
