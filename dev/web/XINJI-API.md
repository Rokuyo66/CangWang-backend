# 心跡後端 API（待接：前端 repo）

後端這一側已完成並測過（`node dev/xinji-test.mts`，31 條）。這份是給前端的契約。

**這一版取代卦案那一格。** `src/part2.html` 現在是
`case: ()=>toast("卦案尚未開放，敬候觀中通告")`——把它換成開啟**心跡**畫面。
卦案的後端（`case_*` 六支 mode）原封不動留著、照樣能呼叫，只是不再有入口；
要不要在後台留一個測試入口自己決定。

版面參考：設計畫布四張（心事時間軸／單一心事／月誌未持牒／月誌已持牒），
配色與字級直接沿用 `dev/play/shell.html` 的那組變數。

---

## 為什麼是這個形狀（接之前先看，否則會接成一個「卦的清單」）

心跡不是卦曆的另一種排法。差別在**它以「一件事」為單位，不是以「一卦」為單位**。

- 一件事會被問很多次（財運與感情這兩類尤其）。
- 同一件事第二次來問，原本會被一事不二占攔下來說「你問過了」。
  現在只要那一卦帶著 `thread_id`，就不攔——他不是重複問，是就同一件事再問一次。
- 一件事有一條時間線、一條溫度線、一組角色留言、一個應期閉環。

所以前端該畫的是「事」，卦是事底下的條目。畫成卦的清單，這個功能就白做了。

## 成本（決定哪些畫面可以放心地天天開）

心跡預設零 AI。時間軸、溫度線、角色留言、月誌統計全是查詢與純計算，
**唯一會呼叫模型的是月誌卷首語，每人每月一次、走 haiku**。

所以：時間軸與心事詳情可以隨便開、可以下拉刷新、可以進頁就打。
不必像起卦那樣先問「這樣會不會很貴」。

---

## 十一支 mode

全部走既有的 `interpret` Edge Function，跟站內其他功能同一支 `callInterpret`：
`POST /functions/v1/interpret`，`Authorization: Bearer <JWT>`，body 帶 `mode`。
錯誤一律 200 ＋ `{kind:"err", msg:"…"}`（`msg` 是可以直接顯示給人看的中文）。

| mode | 送 | 回 |
|---|---|---|
| `xinji_timeline` | — | `{threads, notes, quota}` |
| `xinji_thread` | `thread_id` | `{thread, casts, temperature}` |
| `xinji_open` | `title`、`subject?`、`category?`、`cast_id?` | `{thread, quota}` |
| `xinji_attach` | `cast_id`, `thread_id` | `{cast_id, thread_id}` |
| `xinji_close` | `thread_id`, `close`（預設 true） | `{thread_id, status}` |
| `xinji_delete` | `thread_id` | `{thread_id, deleted}` |
| `xinji_suggest` | `question` | `{thread}`（null＝沒有對應的線） |
| `xinji_note_reply` | `note_id` | `{character_id, thread_id, prefill}` |
| `xinji_note_read` | `note_ids[]` | `{read}` |
| `xinji_month` | `ym?`（`YYYY-MM`，預設本月） | 見下 |
| `xinji_month_index` | — | `{months, paid}` |

`profile` 另外多了三個欄位，導覽紅點與額度標示直接讀它，
**不要為了兩個數字在開 App 時多打一支 `xinji_timeline`**：

| 欄位 | 意思 |
| --- | --- |
| `xinjiOpen` | 現在在記幾件事 |
| `xinjiMax` | 這個方案最多記幾件（免費 1／觀微 3／知己 8／藏往 20） |
| `xinjiUnread` | 未讀的角色留言數（畫紅點用） |

---

## 時間軸 `xinji_timeline`

開這一支時後端會順手熬一次角色留言（零 AI），所以下拉刷新就會長出新留言。

```js
{
  kind:"ok",
  threads:[{
    id, title, subject, category,
    status,                    // open | closed
    cast_count, opened_at, closed_at, days,
    last_gua, last_digest, last_character,   // 最近一卦：卦名、一句話摘要、誰解的
    due_date,
    due_in,                    // 距應期幾天。**負數＝已過**。null＝這條線沒有應期
    due_answered,              // 已回報過了嗎
    verdict,                   // 1應驗 2部分 3未應 0未發生 null未回報
  }],
  notes:[{ id, thread_id, character_id, kind, body, cast_id, created_at, read_at, replied_at }],
  quota:{ open, max },
}
```

排序後端已經處理好：**在記的在前（依最近有卦），已了結的在後（依結案時間新到舊）**。
前端照陣列順序畫就好，不要自己再排一次。

`notes` 只回**還沒回過**的（`replied_at is null`），最多 12 則。
`kind` 有三種，前端可以用不同語氣的圖示：
`due_passed`（應期到了問你後來呢）／`gone_quiet`（擱著了）／`closed`（結案感言）。

`body` 可能含全形星號包住的動作旁白（`＊觀喵甩了甩尾巴＊`），與閒聊同一套格式，
照閒聊那邊現成的渲染走。也可能含 `\n`。

## 心事詳情 `xinji_thread`

```js
{
  kind:"ok",
  thread:{ id, title, subject, category, status, opened_at, closed_at, cast_count, days },
  casts:[{ id, at, question, gua_ben, gua_bian, digest, character_id,
           due_date, verdict, verdict_note }],   // 由舊到新
  temperature:{
    points:[{ cast_id, at, gua, wang, score, basis }],
    levels:["死","囚","休","相","旺"],           // score 0..4 對應這五等
  },
}
```

**溫度線怎麼畫**：`score` 當縱軸（0 在下、4 在上），`levels[score]` 是那一格的字。
2px 線、只標最低點與最新點，不要每點都標數字。

`basis` 是「這條線在看哪一爻」，**必須顯示出來**（設計稿放在卡片右上）。
它可能是 `妻財`、`妻財（伏神）`、`世爻`、`世爻（此卦未取定用神）`。
不顯示的話，這條線就變成一條沒有依據的折線——那正是這個功能最不該給人的印象。

`points` 的數量**可能少於 `casts`**：算不出旺衰的卦（舊資料 chart 不成形）會跳過，
而不是補一個零。前端不要拿 `casts.length` 當點數。

## 記一件新的事 `xinji_open`

`cast_id` 可省。給了就把那一卦當首卦（從卦曆或剛解完的卦進來的路徑）。

額度滿時回的 `msg` 已經是可以直接顯示的話，免費用戶那一句還會指路到「持玉牒入觀」：

```
心跡同時只記得住一件事。要記新的，得先了結手上那一件——或持玉牒入觀，多幾格。
```

不要自己另寫一句「已達上限」蓋掉它。

## 就這件事再問一卦

**這是心跡最重要的一條接線，而它不在上面十一支裡。**

起卦時（既有的起卦 API）body 多帶一個 `thread_id`：

```jsonc
{ "mode": "cast", "question": "…", "lines": [...], "thread_id": "<心事 id>" }
```

帶了之後：

1. **不吃一事不二占的攔截**。他不是重複問，是就同一件事再問一次。
2. 這一卦自動掛到那條線上，時間軸與溫度線立刻更新。

帶一個不存在、不是他的、或已了結的 `thread_id`，後端當作沒帶（照常攔截），
不會回錯——所以不必先驗。

起卦**之前**可以先打 `xinji_suggest` 帶問句，回到一條線就把畫面從
「你問過了」換成「這件事我記得，現在到哪了？」——牆翻成線的那一下，就在這裡。

## 回牠一句 `xinji_note_reply`

回 `{character_id, thread_id, prefill}`。前端該做的是：

1. 開啟與 `character_id` 的閒聊。
2. 把 `prefill`（例如 `關於「阿凱這條線」——`）填進**輸入框**，游標放在後面。

**不要代發。** 代發的話那句話就不是他說的了，而閒聊的價值正好在那裡。
計費照閒聊既有規則走（額度內免費、超出每則扣靈石），這一支本身不計費。

## 月誌 `xinji_month`

```js
{
  kind:"ok",
  ym:"2026-03", current:true,        // current＝這是當月（尚未終月）
  stats:{
    casts, by_category:{感情:5, 財:4, …},
    due_total, answered,
    verdicts:{ hit, partial, miss },
    busiest:{ date, casts } | null,
    open_longest:{ id, title, days, casts } | null,
    closed,
  },
  threads:[{ title, casts }],        // 這月動過的心事
  preface: "…" | null,               // 卷首語。只有持牒者才有
  locked: true | false,
  locked_reason: "三月的卷宗已經齊了。只是觀中無人為你翻開。",   // 只在 locked 時有
  empty: true,                       // 這月沒卦（付費者也不生成）
  gen_failed: true,                  // 生成失敗，統計照給
}
```

**`stats` 免費用戶也拿得到，這是刻意的。** 那本來就是他自己的資料，鎖它只顯得小氣，
而且鎖了他就不知道卷宗裡有東西。封的是「有人為你翻閱」那一層（`preface`）。
設計稿上半截那三個數字（卦／記掛／已回報）就是 `stats`，未持牒也照畫。

`locked` 時把 `locked_reason` 印在封緘卡上，底下才是「持玉牒入觀」的鈕。

`gen_failed` 或 `empty` 時 `preface` 是 null，但 `locked` 是 false——
這時**不要**顯示付費牆，就照常畫統計。付了錢還被推銷是最傷的體驗。

## 往月 `xinji_month_index`

`{months:[{ym, casts, opened}], paid}`，新到舊。`opened` 是「這一卷已經生成過卷首語」。
未持牒者一律畫成「未啟封」——訂了之後回頭補看往月，是續訂的理由。

---

## 前端要做的事

1. `src/part2.html` 那行 toast 換成開啟心跡畫面，那一格改名「心跡」。
2. 心跡三頁：時間軸（心事／月誌兩個分頁）、單一心事、月誌。
3. 起卦流程接兩個點：送出前 `xinji_suggest`，起卦時帶 `thread_id`。
4. 卦曆的每一卦加一顆「記成一件事／歸到某條線」（`xinji_open` / `xinji_attach`）。
5. 導覽紅點讀 `profile.xinjiUnread`。
6. `appBuild` +1 再出 APK。

## 這一版刻意沒有的東西

**沒有自動建立心事。** 起卦不會自己長出一條線——那會讓每一次隨手一問都變成
一件「被記掛的事」，而多數卦本來就是問完就算了。記不記，是他自己決定的動作。

**沒有心事的排序／標籤／搜尋。** 免費 1 條、最高 20 條，還不需要。

**沒有把統計存成快照。** 月誌的統計一律現算，因為回評會遲到（三月的卦，人四月才回報）。
所以同一個月份反覆打，數字**可能會變**——那是對的，不是 bug，不要快取它。
