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

## 先只上 APK，不上網頁

心跡這一版**只在 App 裡開，網頁版維持看不到**。

照藏經那一套走（見 `B26-UNPUSHED.md`）：那一格的入口先寫成 `hidden`，
由 `part2` 依 `isNative` 把 `hidden` 拿掉。網頁版不拿，那一格就不存在。

```html
<button id="xinjiTab" hidden>心跡</button>
```

**不要用 CSS 藏。** `display:none` 的東西在 devtools 裡點得開，而心跡背後那幾支
API 是真的會回資料的——藏得不乾淨等於網頁版也上了，只是難按到。

後端這側不必配合做任何事：那十幾支 mode 在網頁帶 JWT 進來時一樣會回答。
真正的閘門是「網頁上沒有那個入口」，不是後端擋。這個取捨要知道：
**它擋的是誤觸，不是刻意繞過的人。** 心跡沒有任何不能給那個帳號本人看的東西
（全都是他自己的卦），所以這個強度夠用；哪天有真的要擋的東西，得另外做。

## 前端要做的事

1. `src/part2.html` 那行 toast 換成開啟心跡畫面，那一格改名「心跡」，並照上面加 `hidden`。
2. 心跡四頁：時間軸（心事／月誌／語音三個分頁）、單一心事、月誌、語音收藏。
3. 起卦流程接兩個點：送出前 `xinji_suggest`，起卦時帶 `thread_id`。
4. 卦曆的每一卦加一顆「記成一件事／歸到某條線」（`xinji_open` / `xinji_attach`）。
5. 導覽紅點讀 `profile.xinjiUnread`。
6. `appBuild` +1 再出 APK。

---

# 二、語音收藏

## 為什麼要做

`reading-tts.js` 現在每次朗讀都合成一次。**收藏＝把已經合成好的音檔留下來**，
之後重聽不再呼叫 TTS——所以語音頁播放幾百次都是零邊際成本，
而它同時是留存（想再聽一次師兄那句話）與訂閱誘因。
撐住它的是儲存費不是 AI 費，儲存費可預期。

免費 3 段、觀微 10、知己 30、藏往 100。

## ⚠ 這一節的設計與前端現況對不上，先讀這段

前端 `src/modules/reading-tts.js` 已經寫著兩條路，**第一條是伺服器合成**：

```js
r = await apiInterpret({ mode: "tts", cast_id: castId, part });
// 期望 { kind:"ok", parts:[{ url }] }
```

> 前端不送要念的字，只送 cast_id ＋ 哪一段——開放送文字等於把金鑰做成公用 TTS。
> 伺服器自己去 casts 撈、切段、合成、快取，回一串 mp3 網址。

**但後端沒有 `tts` 這支 mode**（全 repo grep 不到），`_shared/voices.ts`
那份音色表也沒有任何一處 import。所以：

- 師兄／師妹／觀貓的聲音**從來沒有真的響過**。每一次朗讀都靜靜退回第二條路
  ——裝置內建語音，一把嗓子、性別由手機決定、旁白整段丟掉。
- 而且它不會報錯：`ttsServer()` 連不上就 `return false` 退回去，畫面上看起來一切正常。

這件事直接推翻下面那套「前端上傳音檔」的設計：

| | 下面寫的（voice_save/voice_confirm） | 前端已經在等的 |
|---|---|---|
| 誰合成 | 前端 | 伺服器 |
| 音檔怎麼進 Storage | 前端簽名上傳 | 伺服器合成時就寫進去 |
| 金鑰在哪 | 前端（如果它自己打 MiniMax，那把金鑰是暴露的） | 伺服器 |

**正確的作法應該是**：先把 `mode:"tts"` 做出來（伺服器合成 ＋ 寫進 `voice` bucket
＋ 以「cast_id＋段落＋音色」為鍵快取），那之後「收藏」就只是**一列指向既有快取檔的紀錄**
——不必上傳、不必去重、不必兩段式確認，`voice_clips` 會縮到現在的三分之一。
而且那份快取一魚兩吃：TTS 成本全站每段只付一次，收藏再多次都是零成本。

下面那套 `voice_save`／`voice_confirm` 先留著（表與服務層都測過），
但**接前端之前要先決定 TTS 在哪裡合成**。這個決定沒下之前不要照著接。

---

## 部署前置：一個 Storage bucket

要先在 Supabase 建一個**私有** bucket，名字 `voice`。不建的話這幾支會全部失敗。
不要設成公開——裡面是付費用戶的東西，清單回的是短效簽名網址（1 小時）。

## 四支 mode

| mode | 送 | 回 |
|---|---|---|
| `voice_list` | — | `{clips, quota}` |
| `voice_save` | 見下 | `{clip, duplicate, upload}` |
| `voice_confirm` | `clip_id` | `{clip}` |
| `voice_delete` | `clip_id` | `{id, deleted}` |

## 收藏一段：兩步

音檔一兩 MB。**不要**把 base64 塞進 `interpret` 的 body——那支函式同時還在服務起卦。

**第一步** `voice_save`：

```jsonc
{ "mode":"voice_save",
  "cast_id":"…", "character_id":"daoshi_m", "kind":"reading",
  "title":"大師兄・《水天需》",          // 必填，直接顯示
  "subtitle":"那筆尾款・三月初二",
  "duration_ms": 134000,
  "bytes": 912345,                      // 必填，先擋超額
  "voice_id":"Chinese_bazong",
  "text_hash":"<朗讀原文 ＋ voice_id 的雜湊>" }  // 必填，去重用
```

回：

```jsonc
{ "kind":"ok",
  "clip": { "id":"…", "title":"…", "ready":false, … },
  "duplicate": false,
  "upload": { "url":"https://…", "token":"…", "path":"<uid>/<clip_id>.mp3" } }
```

**額度在這一步就擋掉**——不會讓人傳了兩 MB 才被告知超額。
擋下來的 `msg` 免費用戶那句會指路到「持玉牒入觀」。

**第二步**：用 `upload.url` 直接 `PUT` 音檔到 Storage，完成後打 `voice_confirm`。

`voice_confirm` **以 Storage 的實況為準**，不信前端說「我傳好了」，也不信 `bytes`：
真實大小由伺服器讀回來覆寫。所以謊報大小沒有用，超過 6 MB 的檔案會連檔帶列一起丟棄。

**`duplicate: true` 的兩種情況**：
- `upload: null` → 這段已經收過而且傳完了。顯示「已在收藏裡」，不必再做任何事。
- `upload: {...}` → 上次收到一半沒傳完。用這張網址續傳完再 confirm，不會長出第二則。

`text_hash` 認的是「同一段文字＋同一把嗓子」。同一段話收兩次是同一則，
既不多佔一格，也不多存一份檔案。

## 清單

```jsonc
{ "clips":[{ "id","cast_id","character_id","kind","title","subtitle",
             "duration_ms","bytes","voice_id","ready","created_at",
             "url":"https://…"   // 短效簽名，1 小時，過期重打 voice_list
           }],
  "quota":{ "used", "max" } }
```

`storage_path` **不下發**，那是伺服器內部的位置。不要去猜它、不要拼它。

## 朗讀那一排要加的鈕

批文底下 `.rd-tools` 現在是「朗讀／存圖」兩顆，加第三顆「收藏語音」。
按下去走上面兩步。已經收過的那一段，這顆鈕該顯示成「已收藏」。

---

# 三、貼紙

## 為什麼要做

零 AI、純毛利，和配色同一類但比配色好賣：配色一個帳號只買一次，
貼紙是包、可以一直出新的，而且**人是在「想貼」的那一刻掏錢**，
不是在商店頁被推銷的時候。所以價錢寫在抽屜裡，不另跳商店頁。

開場四包：觀中常備（免費 8 張）、觀喵の日常（免費 4 張）、
節氣・二十四（160 靈石）、硃砂印記（120 靈石）。
**免費包不必買、也不會寫進 `owned_packs`**——它一律視同已有。

## 六支 mode

| mode | 送 | 回 |
|---|---|---|
| `sticker_shelf` | — | `{packs, max_per_surface}` |
| `sticker_buy` | `pack_id` | `{pack_id, name, paid}` |
| `sticker_place` | 見下 | `{sticker, count, max}` |
| `sticker_move` | `id` ＋要改的欄位 | `{sticker}` |
| `sticker_remove` | `id` | `{id, removed}` |
| `sticker_layout` | `surface` | `{surface, stickers}` |

`packs` 已擁有的排前面，未購的直接帶 `price`。下架的包完全不出現。
每一包都帶 `stickers:[{id, name, asset}]`——未購包的也帶，畫成鎖著的縮圖。
`asset` 是前端資產鍵（`assets/stickers/<asset>.svg`），圖不在後端。

## 貼在哪一頁

`surface` 只認四種形狀，其餘一律回錯：

```
timeline            心事總覽
voice               語音收藏頁
thread:<uuid>       某一條心事
month:YYYY-MM       某一個月的月誌
```

**心跡三頁的回應已經夾帶那一頁的貼紙**（`payload.stickers`），
不要為了貼紙多打一支 `sticker_layout`——那支是給不走那三支的頁面用的。

## 座標：錨點 ＋ 偏移

這是唯一需要想清楚的地方，接錯了貼紙就會亂跑。

| `anchor` | `anchor_id` | `x` | `y` |
|---|---|---|---|
| `page` | null | 寬度的 **0..1** | 距內容頂端的 **px** |
| `thread` / `cast` / `note` | 那張卡的 id | 距該元素左上角的 **px，可為負** | 同左 |

為什麼不全用相對座標：內容一長（時間軸新增一件心事），貼紙就跟它原本貼著的
那張卡錯開了，而人貼的時候心裡想的是「貼在那筆尾款上」。
錨在卡片上的貼紙會跟著卡片走——卡片移動、排序改變、內容變長都不會跑掉。

負偏移是刻意允許的：設計稿裡那枚壓在卡片右上角、露出一半的銅錢就是 `x:-18, y:-14`。

其餘欄位：`rot` 度數（−180..180）、`scale`（0.4..3）、`z`（後端管，新貼的一定最上層）。
`sticker_move` 帶 `front: true` 可以把一張提到最上層。

一頁上限 24 張，滿了回的 `msg` 是「這一頁已經貼了 24 張，再貼就看不見字了。撕一張再貼。」

## 這一版刻意沒有的東西

**沒有自動建立心事。** 起卦不會自己長出一條線——那會讓每一次隨手一問都變成
一件「被記掛的事」，而多數卦本來就是問完就算了。記不記，是他自己決定的動作。

**沒有心事的排序／標籤／搜尋。** 免費 1 條、最高 20 條，還不需要。

**沒有把統計存成快照。** 月誌的統計一律現算，因為回評會遲到（三月的卦，人四月才回報）。
所以同一個月份反覆打，數字**可能會變**——那是對的，不是 bug，不要快取它。

**語音沒有後端合成。** 這一版只管「把前端已經合成好的音檔收起來」。
TTS 在哪裡發生、金鑰放哪裡，不在這份契約範圍內——若目前是前端直接打 MiniMax，
那把金鑰是暴露的，該另外處理。

**貼紙沒有自由縮放以外的變形**（不能翻轉、不能裁切、不能改色），
也沒有「一次貼一排」。等真的有人在用再說。

**貼紙的圖不在後端。** `asset` 只是鍵，圖是前端資產。所以出新貼紙包＝
前端加圖 ＋ 後端 insert 幾列，兩邊都要動——這是刻意的，圖進資料庫的話
每改一張圖就要跑一次 migration。
