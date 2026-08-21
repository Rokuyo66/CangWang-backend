# b26 有、兩個 repo 都沒有的東西（等原機 push）

**先更正一句話。** 我先前查完 b27 與兩個 repo 的所有分支，說「藏經沒有任何一版有這東西」——
那是對 repo 講的，對 b27 也對；但把它推成「還沒寫」是錯的。b26 的 bundle 裡藏經是完整的、
會動的，卦案入口也是開的。東西一直都在，只是沒進 git。

`APP_BUILD` 恰好講完了整件事：repo 的 package.json 是 24 直接跳到 27（commit 9547184），
25 與 26 從來沒進過 repo。b26 是在原機上建的，b27 是照 repo 建的——所以 b27 不是「少改了什麼」，
是從另一條線長出來的。兩邊誰也不是誰的超集。

以下清單是把 b26 的 `assets/public/index.html` 依 build.mjs 的組裝順序拆回原始碼比對出來的。
拆法可信：repo 也有的九支模組裡，六支拆出來與 repo **逐字元相同**（`yong-keywords`／`almanac`／
`yijing-text`／`wangshuai-shensha`／`legal-docs`／`story/mock-events`），另三支的差異都對得上
已知的 commit。

---

## 一、前端 repo（CangWang-web）：b26 有、main 沒有

### 六支新檔案

| 檔案 | 行數 | 做什麼 |
| --- | --- | --- |
| `src/modules/canon.js` | 123 | 藏經書目：兩層書架（六爻／易經）、12 部書的題解。只有書目，沒有內文 |
| `src/styles/canon.css` | 118 | 書架／書／卷三個畫面，`cn-` 前綴 |
| `src/case/case-play.js` | 3,203 | 卦案前端。**產生檔**，源頭在後端 repo（見下） |
| `src/styles/case.css` | 24 | 卦案宿主層：`.cs-root` 蓋在哪、瀏海與底部手勢區怎麼讓 |
| `src/modules/reading-image.js` | 251 | 批文存成圖片 |
| `src/modules/reading-tts.js` | 165 | 批文朗讀 |

### 兩份資產

- `assets/canon/_index.json` — 目前是 `{"books":[]}`。書架上 12 部，11 部要
  `assets/canon/<id>.json` 才有內文，一部都還沒謄；`周易・六十四卦卦爻辭` 是特例
  （`local:"zhouyi64"`），直接吃已經在 bundle 裡的 `yijing-text.js`，不必 JSON。
  所以 b26 裝上去，藏經打得開、周易讀得到，其餘 11 部會顯示「尚未入藏」。
- `assets/art/README.md` — 卦案美術的檔名規格（場景分日夜、NPC 立繪、同行立繪、封面）。

`build.mjs` 也要一起帶：它得把 `assets/canon/` 與 `assets/art/` 原樣複製到 `dist/`。

### `part1.html`：9 處（582 行）

| 位置 | 改動 |
| --- | --- |
| ~452 | `.rd-tools`／`.rd-tool` — 批文下方朗讀／存圖兩顆鈕 |
| ~524, ~594 | 伏神改吃 `.bgrp/.bqin/.bgz` 同一組字級（同一張盤不要兩套讀法） |
| ~658 | `.cn-tab` — 刻意不叫 `.ctab`，否則開卦曆會洗掉藏經的分頁狀態 |
| ~1263 | `#canonTop{order:8}`＋`.topbar` 補 `flex-wrap`（頂列多一格，320px 機會溢出） |
| ~1268 | `__MODULE_CSS__` 多了 canon.css 與 case.css 兩塊 |
| ~1273 | `<button id="canonTop" hidden>藏經</button>`，由 part2 依 `isNative` 拿掉 hidden |
| ~1413 | 存圖彈框標題改成 `<h3 id="imgTitle">`（同一張畫布要出兩種內容） |
| ~1548 | `#canonPanel` 整層（沿用 `.calpanel`，全屏化與讓開底部導覽的規則就自動生效） |
| ~1632 | `<div class="cs-root" id="caseRoot"></div>` |

### `part2.html`：36 處（389 行）

大的四塊：

- **藏經**（~1652 起，170 行）：`renderCanon`／`renderCanonShelf`／`renderCanonBook`／
  `renderCanonVol`／`canonLoad`／`canonLoadIndex`／`canonBack`／`zhouyiChapters`。
  入口只在 App 露出（`isNative`），註解寫明要放給網頁版就把那行判斷拿掉。
- **卦案**（~1975 起，51 行）：`openCasePanel`／`closeCasePanel`，掛 `CasePlay.mount(caseRoot)`。
- **解卦工具列**（~576 起，88 行）：`readToolsHtml`／`bindReadTools`／`bindThreadTts`／
  `threadTtsHtml`／`openReadingImage`／`wireTtsBtn`，接上 reading-image 與 reading-tts。
- **返回鍵層級表**（~3354）：加 `canonPanel`（close 走 `canonBack()`，在卷裡按返回要退回書，
  不是一路退出藏經）與 `caseRoot`。

小的：`tabbar` 的 `case:` 由 toast 改成 `openCasePanel()`、`current()` 認得 `caseRoot`、
存圖檔名改吃 `imgLabel`、閒聊角色列與對話泡泡改吃 `charAvUrl()`（換過的頭像處處一致）、
`APP_BUILD` 26、更新公告多一則 2026-08-20。

---

## 二、後端 repo（CangWang-backend）：原機也比這裡新

`case-play.js` 的檔頭自己講了：

```
來源：D:CangWang 的 dev/web/entry.ts ＋ supabase/functions/_shared/{core,case,case-engine,case-schema,cases}
重新產生：在後端 repo 執行  node dev/build-case-web.mjs
引擎與案件檔的唯一作者在後端 repo（伺服器要用同一份判定進度）
```

這兩支都不在推上來的 backend 裡：**`dev/build-case-web.mjs`** 與 **`dev/web/entry.ts`**。
（`dev/web/PORTRAIT-FULLBLEED.md` 早就寫過 entry.ts 只在公司機。）

更要緊的是**案件檔的形狀已經長出去了**。b26 內嵌的 HUANGCUN 有這裡沒有的頂層欄位：

```
synopsis  prologue  dawnHour  duskHour  truthFacts  omens  invites  closing  window
```

`_shared/cases/huangcun.ts` 現在只有 `id title version question useQin truth entryHour
voidPolicy regions npcs clues companions`。也就是 `case-schema.ts`／`case-engine.ts`
在原機上都改過了（前情提要、日夜場景、美術 key、邀約、結語…）。

**push 順序建議：後端先，前端後。** 前端那支 case-play.js 是產生檔，後端沒到位就重新產生不出來。

---

## 三、push 會撞到的四處

| 檔案 | 誰比較新 | 怎麼辦 |
| --- | --- | --- |
| `src/styles/story.css` | **main**（差 107 行） | main 有 ae0b229 的滿版立繪改版（`--st-name-h`／`--st-box-h`／`.st-portrait{inset:0}`），b26 是改版前。**留 main 那版** |
| `src/story/engine.js` | **main**（差 9 行） | main 有 `portraitKind` 與 DOM 順序調整（遮罩排在立繪之後）。**留 main 那版** |
| `src/modules/cast-image.js` | **b26**（差 8 行） | b26 把存圖的伏神字級／基線對齊變卦那格（`F(13)`／`F(15)`／`cy+14`）。**留 b26 那版** |
| `package.json` `appBuild` | — | main 27、b26 26。合完設 **28** 再出 APK |

前三個是同一件事的兩半：立繪滿版走了 main，盤面與存圖走了 b26，各自都沒錯，逐檔挑就好。

---

## 四、跟我這一版後端的關係（要先講清楚）

我這條分支（`claude/check-sutra-divination-updates-c05416`）照你選的「正規做法」開了六支
`case_*` mode，一局的判定全在伺服器：`case_start` 由伺服器擲卦、`case_action` 比對
`options()` 才受理、truth 只在破案時下發、寫回帶 `seq` 樂觀鎖。

而 b26 的 `case-play.js` 是**純前端**跑同一套引擎（`grep fetch` 零命中，`CASES=[HUANGCUN]`
內嵌）。兩者現在是兩套判定。合的時候要挑一邊：

- 走伺服器判定（你選的那條）：`case-play.js` 的畫面全部留著——它已經有手機直式版面、
  `pv-` 樣式、美術載入、前情提要，那是最貴的部分。要換掉的只是它內部呼叫引擎的地方，
  改成打六支 `case_*`。契約在 `dev/web/CASE-API.md`。
- 先維持純前端：那我這條分支就先擱著，等你要接存檔與獎勵時再啟用。

另外，我的 `_shared/case-run.ts` 是照**現在推上來的**（舊的）case-schema 寫的。
你把新的 schema／engine push 上來之後，這一層要跟著補：`synopsis`／`prologue` 要進下發的
payload，`dawnHour`／`duskHour` 會影響 `startRun`，美術 key 要一起送。判定邏輯本身不用動
（那一層只呼叫引擎），要動的是 payload 的白名單。

---

## 五、萬一原機真的拿不到

b26 的 bundle 拆得回來，方法已經驗證過（六支模組逐字元相同）。拆得回來的：
六支新檔案、三支 CSS、`assets/canon/_index.json`、`assets/art/README.md`。
拆不回來的：`part1.html`／`part2.html` 要把 `__TEMPLE_IMG__` `__AVATARS__` `__FAVICON__`
`__ICON32__` `__SUPABASE_JS__` `__FONT_CSS__` `__MODULE_CSS__` `__APP_BUILD__` 八個佔位符
回插；以及後端的 `dev/build-case-web.mjs` 與 `dev/web/entry.ts`——那兩支沒進 bundle，
沒有它們，`case-play.js` 拿得回來但下次改卦案就重新產生不出來。
