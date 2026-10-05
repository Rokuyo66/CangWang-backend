# 美術與動態規範

**這個資料夾是全站美術的唯一依據。** 前端（`Rokuyo66/CangWang-web`）沒有自己的一份。

| | 位置 |
| --- | --- |
| **美術規範（總）** | `style/`：五套主題色碼（可即時改、可存檔）、按鈕、版面與留白（App／手機／網頁三組數字）、App 與網頁差異，並嵌入下面的動態規範。原始檔 `style/index.html`，初值與基準 `style/state.json`（抄自前端 `src/part1.html`），`node dev/design/style/build.mjs` 產出 `style/spec.html`。發佈在 https://claude.ai/artifact/SiQre47unz6og8MP5Yu3Nt |
| **動態＋元件規範（主）** | `motion/prototype.html`：可點的原型。Token、按下與放開（有厚度的元件）、通用 TAG 頁籤、彈框與頁面、待機、強調、規則卡。同一份發佈在 https://claude.ai/artifact/EqkEtiWmrMhEPfn8VMjAZL |
| 道緣事件劇本格式 | `journal/EVENT-SCRIPT.md`（試演台：前端網址加 `?preview=editor`） |
| 心跡／手帳 | `xinji/`、`journal/` |

## 怎麼用

做任何看得見的東西之前——前端頁面、這裡的原型、小工具原型 `dev/widget/`——**先打開規範，找到它屬於哪一類，照規範做**：

1. 規範裡有這一類：前端用對應的共用 class（對照表在前端 `CLAUDE.md`「美術規範是唯一依據」），不另寫顏色、厚度、時長、曲線。
2. 規範裡沒有：先在這裡補一段可點的示範＋規則卡，再去實作。規範是依據，不是事後追認。
3. 前端現有樣式跟規範不一樣：以規範為準，改前端共用的那一處，全站一起變。
4. 做完拿規範原型裡同一類的元件並排截圖比對（淺色與夜觀各一張）。

目的：調規範時只改 token 或共用 class 一處，全站就跟著變。每一個「這一頁先照舊」都會讓這件事失效。

## 在規範頁上改色碼、存檔之後

規範頁（artifact）上的「存檔」會把修改寫進那份 artifact 本身，repo 裡的 `style/state.json` 不會跟著變。
開新會議套用時：

1. 讀那份 artifact（Artifact 工具的 `read`），頁面「待套用」一區有逐項清單與一段說明；狀態在 `<script id="spec-state">` 那包 JSON。
2. 照說明改前端（主題色碼在 `src/base/00-tokens-themes.css`，按鈕在 `src/styles/motion.css`；2026-10-05 前是 `src/part1.html`）。
3. 把 artifact 的狀態寫回 `style/state.json`，並把 `baseline` 設成新值（套用完就沒有待套用），重跑 build、重新發佈同一個網址。
