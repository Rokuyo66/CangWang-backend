# 心跡設計畫布

四張手機直式畫板，是 `dev/web/XINJI-API.md` 那份契約的視覺對照：

| 檔 | 畫的是 |
|---|---|
| `Main.dc.html` | 心事時間軸（心跡的首頁，取代原卦案那一格） |
| `Thread.dc.html` | 單一心事：歷次卦 ＋ 緣分溫度線 |
| `MonthlyLocked.dc.html` | 月誌 · 未持牒（統計照給，卷首語封緘） |
| `Monthly.dc.html` | 月誌 · 已持牒（卷首語＋所問／所應／未了） |

`canvas.json` 是版面與便條。

## 配色與字級不是新訂的

全部沿用 `dev/play/shell.html` 那組變數，數值直接抄：

```
--bg:#12100e  --panel:#1a1714  --line:#332c25  --ink:#e8e0d4
--dim:#8b8073 --gold:#c8a86b   --warn:#a8623f  --ok:#7d9a6a
font-family:"Noto Serif TC","Songti TC",serif   line-height:1.75   border-radius:2px
```

只多了一個：`#9c3b30`（硃砂），只用在印記與封緘——應驗的戳、月誌的「封」、
應期已過那條線的左邊框。它是站內唯一「這裡有一件事要你處理」的顏色，別拿去當裝飾。

手帳的質感來自版面不是字體：欄線（`repeating-linear-gradient`，27/28px 對齊
`line-height`）、左側日期溝、印記方框。沒有用手寫體——Google Fonts 上沒有堪用的
繁體手寫，硬套會 fallback 成一團糟。

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
