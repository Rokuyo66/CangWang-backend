# 手帳改版：架構、介面、入場

核心定位：**一本「一邊解惑、一邊與三位角色談心」的紀錄手帳。**
可點原型：`prototype.html`（腳本對話，不接後端）。

---

## 一、現況診斷（前端 `CangWang-web` @ `ec6458e`，b53）

### 1. 「頁」沒有統一的定義

同樣是「一個全屏畫面」，現在有 8 種開關寫法：

| 寫法 | 誰在用 |
|---|---|
| `.screen.on`（`showScreen`） | 問事、搖卦、結果、廣場 |
| `.calpanel.on` | 卦曆、知庫、藏經 |
| `.member.on` | 道籍 |
| `[hidden]` | 閒聊 dock |
| `.xj.on`（自建 DOM） | 心跡 |
| `.st-root.on` | 道緣事件 |
| `.cs-root.on` | 卦案 |
| `.modal.on` | 十多個彈窗 |

### 2. 加一頁要改 7 處

`part1` 的 markup ＋ CSS、`PAGES`（`showPage`）、返回鍵 `LAYERS`、導覽 `current()`、
導覽 `NAV`、`toTop()` 的捲動容器清單。三份清單各自手寫，漏一份就出 bug——
藏經蓋住卦曆那次（`CLAUDE.md` 記過）就是這樣來的。

### 3. `part2.html` 是 4,700 行的單一 `<script>`

全域作用域、沒有功能邊界。`src/modules/`、`src/xinji/` 已經證明「拆出去」可行，
但主流程（問事、閒聊、道籍、廣場、卦曆）都還在裡面。

### 4. 角色不在第一層

首頁是問事表單；三位角色藏在右下 FAB（閒聊）與道籍分頁裡。
入場引導 7 頁全是大師兄講規矩，師妹與觀貓只在第 7 頁被提到一句。
產品的差異化（有角色）在第一次打開時幾乎看不到。

---

## 二、資訊架構（IA）

導覽五格：**觀堂 · 談心 · 〔問〕 · 手帳 · 道籍**

| 格 | 內容 | 由現行哪裡來 |
|---|---|---|
| 觀堂（首頁） | 待回報的應期 → 三人此刻狀態 → 最後一句話 → 籤／簽到 | 新；籤條、簽到從頂列搬下來 |
| 談心 | 全屏對話幕（幕）＋紙本履歷（卷） | 閒聊 dock |
| 問（中央印章） | 問事 → 搖卦 → 結果 → 批文 | 問事，流程不動 |
| 手帳 | 時序／月曆／心事 三種看法 | **心跡＋卦曆合併** |
| 道籍 | 我、道緣名片、頭像、信箱、知庫、廣場、藏經、設定 | 道籍＋頂列雜項 |

頂列收成一行：節氣日期（左）＋靈石（右）。廣場、藏經降為道籍與觀堂的次層入口。

---

## 三、目標架構

### 1. 一份頁面註冊表，其餘全部由它推導

```js
// src/app/router.js
App.page({
  id: "journal",
  tab: "journal",          // 亮哪一格；null＝不亮（如藏經）
  layer: "page",           // page(10) ｜ sheet(40, 彈窗) ｜ scene(70, 全屏對話幕)
  mount(el) {},            // 第一次開時建 DOM（照心跡做法，markup 不寫在 part1）
  open(params) {},
  close() {},
  back() { return false }, // 有內部層級時自己退一層（藏經：卷→書→架），回 true 表示吃掉
});
App.go("journal", { view: "month" });
```

`showPage`、返回鍵的 `LAYERS`、導覽的 `current()`／`NAV`、`toTop()` 全部改成讀這份表。
加一頁＝加一個資料夾＋一次 `App.page()`。

### 2. 目錄

```
src/app/        router.js、api.js（apiInterpret 等）、state.js（profile、靈石、紅點）
src/ui/         scene.js ＋ scene.css —— 對話幕元件（見下）
src/pages/      hall/ chat/ ask/ journal/ me/ canon/ plaza/ ……，各自 index.js ＋ style.css
```

`build.mjs` 的 `JS_DIRS` 加上 `src/app`、`src/ui`、`src/pages/*`；CSS 同理。
仍是單一 `index.html`、不引入 import/export，與現行管線相容。

### 3. 對話幕是一個元件，四個地方用

入場引導、談心、道緣事件（`st-`）、卦案（`pv-`）現在是兩份版面寫兩遍，
`CLAUDE.md` 已經記了「劇情層與卦案併成同一個對話元件」。這次一起做：

```js
const s = Scene.mount(el, { resolve: artKey => url });
s.bg("yard"); s.speak("daoshi_m"); await s.say("「說吧，什麼事。」");
const pick = await s.choose([{ b: "就問這一卦", go: true }, { b: "先不問" }]);
```

版面數值沿用 Figma「幾知觀 · 卦案立繪版面」（立繪頂讓 120／框高 220～76dvh）。

---

## 四、遷移順序（每一步都能單獨出版）

| 步 | 做什麼 | 畫面變化 |
|---|---|---|
| S1 | `router.js`，現有 8 種頁面各包一層轉接，三份清單改讀註冊表 | **無**（純重構） |
| S2 | 抽出 `Scene` 元件，道緣事件先換上 | 幾乎無 |
| S3 | 談心：dock → 全屏幕＋卷；擬題卡改選項框 | 大 |
| S4 | 入場引導：三人登場、選引路人、依來意分流 | 大 |
| S5 | 觀堂首頁＋導覽改五格；頂列瘦身 | 大 |
| S6 | 心跡＋卦曆合併為手帳 | 大 |

S1、S2 先做，後面四步才不會又把新頁寫成第九種開關法。

**進度（前端 `CangWang-web` › `claude/elegant-faraday-wf941u`）**

| 步 | 狀態 |
|---|---|
| S1 | ✅ b54 · `src/app/router.js` |
| S2 | ✅ b55 · `src/ui/scene.js`（入場、談心已用；道緣事件 `st-` 與卦案 `pv-` 尚未併入） |
| S3 | ✅ b55 · 幕／卷。卷沿用原訊息串，沒改成欄線紙本 |
| S4 | ✅ b55 · `src/pages/intro.js`。引路人暫存本機 |
| S5 | ✅ b56 · `src/pages/hall.js`；手機頂列只留靈石，簽到／廣場／藏經搬進觀堂 |
| S6 | ◐ b55 · 心跡與卦曆互相以頁籤切換；「時序」合併檢視要等合併 API |
| 道緣 | ◐ b61 · 觀堂事件泡泡（`storyReady`）已做、STORY_OPEN 仍關；上線計畫見 [DAOYUAN-PLAN.md](DAOYUAN-PLAN.md) |

---

## 五、後端要配合的

- `profiles.guide_char`：入場選的引路人（預設批卦者、觀堂標記）。`guide_seen_at` 沿用。
- 角色狀態字（「在後院練劍」）：可先前端依時辰寫死，之後再搬進資料層。
- 手帳時序：先由前端合併 `xinji_*` 與 `calendar` 兩支回應；量大了再出一支合併 API。

## 六、美術缺口

立繪只有大師兄一張測試圖（`character_01_a_01.png`）。師妹、觀貓沒有立繪時，
對話幕退回「場景底圖＋頭像」，版面照樣成立——但遊戲感的上限取決於這兩張。
規格同 `assets/art/README.md`：900×1200 去背，主體落在中央 60%。
