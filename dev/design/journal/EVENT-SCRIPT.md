# 道緣事件劇本格式（character_events.scenes／choices）

前端播放器：前端 repo `src/story/engine.js`（畫面借談心的對話幕 `src/ui/scene.js`）。
版面預覽：網址加 `?preview=event`，演 `src/story/sample.js` 那一章（大師兄「掌門師兄」範例，台詞是佔位的）。
預覽不打後端、不發獎、不記進度。

## 一幕

`scenes` 是陣列，一個元素一幕，照順序演；欄位全部選填。

| 欄位 | 意思 |
|---|---|
| `id` | 這一幕的名字，給 `to`／`next` 指路 |
| `bg` | 場景 key（`guanmen` 觀門、`cangjingge` 藏經閣、`dadian` 大殿、`zhongting` 中庭、`langxia` 廊下、`qianting` 前廳、`xiangfang` 廂房、`zaofang` 灶房、`houyuan` 後院、`wuji` 屋脊）。**跟上一幕不同＝換場**：黑場＋地名，立繪先收起 |
| `place` | 換場時打出來的地名（例：`中庭・拂曉`）；沒寫就用上表的名字 |
| `portrait` | `"AUTO"`＝這一章的角色；角色 id；`null`＝收起；**沒寫＝沿用上一幕** |
| `who` | 說話的角色 id（`daoshi_m`…）。名字旁的小字自動帶他目前的身分 |
| `speaker` | 說話者的字（沒有 `who` 時用；寫這一章角色的名字等於 `who`） |
| `me` | `true`＝你說的話（說話者顯示「你」，金色） |
| `text` | 台詞，`\n` 換行 |
| `choices` | `[{key, label, hint?, to?}]`：選項。選了跳到 `to`（幕的 `id` 或序號），沒寫 `to` 就往下一幕 |
| `next` | 沒選項時往哪一幕（`id` 或序號） |
| `end` | `true`＝演完這一幕就結束 |

`who`、`speaker`、`me` 都沒有＝**旁白**（置中、淡色、字小一級）。事件以對話為主，旁白一句帶過就好。

你選的那句話會留在下一句的上方（「你　……」），像談心裡的回聲——不必再寫一幕「你說：……」。

章末的 `choices` 欄（舊格式）視同最後一幕的 `choices`。進度記的是**最後一個**選項的 `key`。

## 分支的寫法

```jsonc
[
  { "who": "daoshi_m", "text": "「在。」\n「我沒蓋過一次。」",
    "choices": [
      { "key": "why",  "label": "為什麼不蓋？", "to": "why" },
      { "key": "wait", "label": "你在等什麼？", "to": "wait" } ] },
  { "id": "why",  "who": "daoshi_m", "text": "「蓋了，那個位子就是我的了。」", "next": "library" },
  { "id": "wait", "who": "daoshi_m", "text": "「等一冊書。」", "next": "library" },
  { "id": "library", "bg": "cangjingge", "text": "他領你進了藏經閣。" }
]
```

兩條路各自寫到結尾時，每條的最後一幕加 `"end": true`，不會演到另一條去。

## 演完之後

伺服器 `event_finish` 判定並發獎（見 `0065_event_form.sql`：`reward_title`、`reward_lingshi`、`reward_avatar`、`reward_memory`），
前端疊一個「此章已了」的獲得彈框：身分做成一張卡片彈出、掠光一次（動態規範 E 強調），
靈石／頭像／記憶一行一行列在底下；身分那張有「換上這個身分」。重看已了的章不再跳彈框。
