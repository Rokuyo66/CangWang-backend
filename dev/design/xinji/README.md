# 心跡設計畫布

手機直式畫板，是 `dev/web/XINJI-API.md` 那份契約的視覺對照：

| 檔 | 畫的是 |
|---|---|
| `Main.dc.html` | 心事時間軸（心跡的首頁，取代原卦案那一格） |
| `Thread.dc.html` | 單一心事：歷次卦 ＋ 緣分溫度線 |
| `Voice.dc.html` | 語音收藏 |
| `StickerDrawer.dc.html` | 貼紙口袋展開、一張正在被拖出來 |
| `MonthlyLocked.dc.html` | 月誌 · 未持牒（統計照給，卷首語封緘） |
| `Monthly.dc.html` | 月誌 · 已持牒（卷首語＋所問／所應／未了） |
| `ChatBridge.dc.html` | 閒聊 → 心跡 → 起卦：擬題確認卡的三種狀態 |

`canvas.json` 是版面與便條。

## 配色：宣紙暖白，不是墨底

**以美術規範的 token 為準，色碼看 `dev/design/tokens.json`（規範頁可以直接切五套主題看）。**
這幾張畫布裡寫死的色碼是 2026-08 的近似色，跟規範對不上（例如紙 `#F7F3EA`／規範 `#F2EBDA`、墨 `#3A322A`／規範 `#1C1917`），
畫布不重上色，實作時一律照下表換成 token：

| 畫布裡叫 | 畫布色（作廢） | 實作用 |
|---|---|---|
| 紙 | `#F7F3EA` | `--paper` |
| 卡 | `#FFFDF8` | 亮一階的紙：淺色主題 `color-mix(in srgb, var(--paper) 45%, #fff)`、深色主題 `--paper-2`（與按鈕面同一條算式） |
| 欄線／邊 | `#E6DCC8`／`#E0D5BF` | `--hair`／`--paper-edge` |
| 墨／次／淡 | `#3A322A`／`#8A7C68`／`#B5A88F` | `--ink`／`--ink-soft`／`--ink-faint` |
| 金（重點與數字） | `#B08A4A` | `--gold` |
| 硃砂（只給印記與封緘） | `#C0483A` | `--cinnabar` |
| 應驗／未應 | `#7A9163`／`#C07A4A` | 應期回報三色 `--v-hit`／`--v-part`／`--v-miss`（依語意挑；值借各主題五行色） |
| 分類色：感情／財／事業／其他 | `#E9C7BE`／`#CBD9B9`／`#C3CFDE`／`#DED5C4` | **還沒有 token**。上站前先在 `tokens.json` 定一組（要不要跟主題換色由六六決定），不要直接抄這四個色 |

圓角：卡 14／小片 10／鈕 999。字：Noto Serif TC 內文 ＋ Noto Sans TC 小標籤數字。

硃砂只用在印記與封緘——應驗的戳、月誌的「封」、應期已過那條線的邊框、「回報」鈕。
它是站內唯一「這裡有一件事要你處理」的顏色，別拿去當裝飾。

**更正一句先前寫錯的話。** 這份 README 原本說心跡的宣紙暖白「與站內既有的墨底
是兩套」——那是把 `dev/play/shell.html`（卦案原型）的配色當成了主站的。
接前端時對出來：**主站（`src/part1.html` 的 `:root`）本來就是宣紙暖白**
（`--paper:#F2EBDA`、`--ink:#221E1A`、`--cinnabar:#B5402E`、`--gold:#9A7B3F`），
與心跡同一系。真正的墨底只有卦案原型那一支。

所以「兩套配色」的問題比原本以為的小，而心跡這幾張與主站是接得上的。
`ChatBridge.dc.html` 用的就是主站那一組（它畫的卡片出現在閒聊畫面上）；
心跡那四張的色票與主站略有出入（卡片 `#FFFDF8` vs 主站的紙 `#F2EBDA` 等），
那是可以收斂的細節，不是兩個 App 縫在一起。

**餘下的差異：`dev/play/shell.html`（卦案原型，`--bg:#12100e` 那組）仍是墨底。**
要嘛心跡自成一格（像一本夾在觀裡的手帳），要嘛整站跟著換——不要各半，
那會像兩個 App 縫在一起。這個決定還沒下。

手帳的質感來自版面不是字體：欄線（`repeating-linear-gradient`，27/28px 對齊
`line-height`，字才坐得上去）、左側日期溝、紙膠帶、印記方框、卡片的極淡投影。
沒有用手寫體——Google Fonts 上沒有堪用的繁體手寫，硬套會 fallback 成一團糟。

## 貼紙不是裝飾圖

畫面上那些銅錢、貓爪、紙膠帶都是**使用者自己貼上去的**，位置存在
`placed_stickers`（見 `0046`）。所以：

- 版面不能做死。卡片之間要留得下貼紙壓角的空間，`overflow` 不要切掉。
- 貼紙有 x／y／旋轉／縮放／層級，而且**錨在元素上**——壓在「那筆尾款」右上角的
  那枚銅錢，會跟著那張卡走。座標規則見 `dev/web/XINJI-API.md`。
- 右下角的口袋鈕是全域的，每一頁都有；抽屜裡未購的包直接標價。

出新貼紙包＝前端加圖（`assets/stickers/<asset>.svg`）＋ 後端 insert 幾列。

## 重建成品檔

成品 `xinji-handbook.html` 是 2MB 的編輯器 payload，不進 repo（見 `.gitignore`）。
要重建（需要 `design` skill 的 `seed-canvas.mjs` 與 `payload.template.html`）：

```bash
node "<skill 目錄>/seed-canvas.mjs" \
  --template "<skill 目錄>/payload.template.html" \
  --out xinji-handbook.html --title "心跡 手帳" \
  --artboard Main.dc.html --artboard Thread.dc.html \
  --artboard MonthlyLocked.dc.html --artboard Monthly.dc.html \
  --canvas canvas.json
```

改設計就是改這四個 `.dc.html`，再 seed 一次。不要直接改成品檔。
