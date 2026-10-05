# 美術與動態規範

**這個資料夾是全站美術的唯一依據。** 前端（`Rokuyo66/CangWang-web`）沒有自己的一份。

**所有數字只有一份：`tokens.json`。** 五套主題色碼、色碼說明、按鈕四型與兩段開關的算式、動態 token（時長、曲線、厚度、幅度）、小工具配色對照，全在這一檔。
改規範＝改這一檔＋跑一次生成器，下表每一個落點一起變（見下方「改規範的流程」）。

| | 位置 |
| --- | --- |
| **token（唯一真相）** | `tokens.json`；生成器 `tokens/build.mjs` |
| **美術規範（總）** | `style/`：五套主題色碼（可即時改、可存檔）、按鈕、版面與留白（App／手機／網頁三組數字）、App 與網頁差異，並嵌入下面的動態規範。原始檔 `style/index.html`（清單與算式讀 `tokens.json`），`style/state.json` 只放「改了還沒套用」的值與歷史，`node dev/design/style/build.mjs` 產出 `style/spec.html`。發佈在 https://claude.ai/artifact/SiQre47unz6og8MP5Yu3Nt |
| **動態＋元件規範（主）** | `motion/prototype.html`：可點的原型（token 讀 `tokens.json`）。Token、按下與放開（有厚度的元件）、通用 TAG 頁籤、彈框與頁面、待機、強調、規則卡。同一份發佈在 https://claude.ai/artifact/EqkEtiWmrMhEPfn8VMjAZL |
| 道緣事件劇本格式 | `journal/EVENT-SCRIPT.md`（試演台：前端網址加 `?preview=editor`） |
| 心跡／手帳 | `xinji/`、`journal/` |

## 怎麼用

做任何看得見的東西之前——前端頁面、這裡的原型、小工具原型 `dev/widget/`——**先打開規範，找到它屬於哪一類，照規範做**：

1. 規範裡有這一類：前端用對應的共用 class（對照表在前端 `CLAUDE.md`「美術規範是唯一依據」），不另寫顏色、厚度、時長、曲線。
2. 規範裡沒有：先在這裡補一段可點的示範＋規則卡，再去實作。規範是依據，不是事後追認。
3. 前端現有樣式跟規範不一樣：以規範為準，改前端共用的那一處，全站一起變。
4. 做完拿規範原型裡同一類的元件並排截圖比對（淺色與夜觀各一張）。

目的：調規範時只改 token 或共用 class 一處，全站就跟著變。每一個「這一頁先照舊」都會讓這件事失效。

## 改規範的流程（色碼、按鈕、動態數字一律這樣改）

1. **改 `tokens.json`。** 規範頁上調好、存檔的值，照頁面「待套用」那一區的說明寫進來（讀 artifact 用 Artifact 工具的 `read`，狀態在 `<script id="spec-state">`）。
2. **跑生成器**：`node dev/design/tokens/build.mjs --web <前端 repo 路徑>`。下表的落點一起寫好。
3. `style/state.json` 的 `themes`／`buttons` 設成跟 `tokens.json` 一樣（沒有待套用），`node dev/design/style/build.mjs` 重產規範頁，重新發佈兩份 artifact。
4. 前端 `npm run build`。**生成區被手改過、或不是同一次產生的，build 直接失敗**——這就是「改一處全站一起變」的保證。
5. 兩個 repo 各自推送；前端淺色與夜觀各截一張與規範並排比對。

只想確認有沒有落差：`node dev/design/tokens/build.mjs --web <前端> --check`。

### 生成器寫到哪裡（落點）

每個落點裡有一段 `@design:begin 名字 … @design:end 名字` 的生成區，只有這段會被改寫，前後的字不動。

| 落點 | 生成區 | 內容 |
| --- | --- | --- |
| 前端 `src/base/00-tokens-themes.css` | `theme-xuan` … `theme-porcelain` | 五套主題色碼 |
| 前端 `src/styles/motion.css` | `motion` | 動態 token（`--m-*`） |
| 前端 `src/styles/motion.css` | `buttons` | 按鈕四型（`.btn`、`.primary`、`.second`、`.fill`） |
| 前端 `src/styles/motion.css` | `seg` | 兩段開關六色（`--seg-*`，淺色一條、深色一條） |
| 前端 `src/app/design-tokens.js` | `design-js` | JS 用的同一份（`DESIGN.motion.ms.press` 等；`ui/motion.js` 讀它） |
| 前端 `android/…/widget/Palette.java` | `palette` | 小工具五套配色（欄位對照在 `tokens.json` 的 `widget.map`） |
| 後端 `style/index.html` | `spec-design` | 規範頁的主題清單、色碼說明、按鈕算式 |
| 後端 `motion/prototype.html` | `proto-motion`、`proto-motion-js` | 動態原型的 `:root` token 與 token 表、總控預設值、範例碼 |
| 後端 `dev/widget/entry.ts` | `widget-colors` | 小工具原型的六個 App 色（背板與材質是原型自己的） |

新增一個要吃 token 的落點：在檔裡放一對空的 `@design:begin`／`@design:end`，在 `tokens/build.mjs` 的 `TARGETS` 加一列、寫產生內容的函式，再在上表補一列。
**不要在落點裡另寫一份數字**——那正是 2026-10-05 以前的狀況：同一組值抄在 7 處，待機幅度在前端是 5%、原型還是 3%。

### 待收編（元件自己的數字，還沒進 token）

規範的核心 token 已統一。以下是元件各自寫死的時長，改的時候順手收進 `tokens.json`（新增一個 duration）再讓元件吃它：

- 前端 `ui/motion.js`：談心浮窗收起 240ms、頁籤底塊滑動 340ms
- 前端 `styles/*.css`：圖示跳一下 620ms、強調彈出 420ms、紅點 520ms、靈石掠光 800ms 等約 15 處 `calc(…ms * var(--m-k))`
- 前端 `src/base/00-tokens-themes.css` 的 `--t-dur`／`--t-dur-panel`／`--t-ease`／`--t-shift`（整頁切換的舊 token，與動態 token 並存；手機 App 由 `motion.css` 對齊成規範值）
- 尺寸 token（`--screen-pad`、`--tap-min`、`--radius-pill`…）目前在前端 `00-tokens-themes.css` 與 `18-mobile.css`，規範頁「版面與留白」是另抄的一份——下一步也收進 `tokens.json`
