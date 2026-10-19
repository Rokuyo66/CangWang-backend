# 玉牒方案頁：`plan_list` 契約

前端：`src/main/15-member-tabs.js` 的 `renderPlanTab`。

## 回傳

```jsonc
{
  "kind": "ok",
  "plans": [
    {
      "id": "guanwei", "label": "觀微", "twd": 150, "lingshi_grant": 60,
      "blurb": "…", "tts_free_readings": 0, "sort": 1,
      "casts": 3, "followups": 3, "chats": 25,
      "memories": 12, "pins": 1, "threads": 3,
      "favor_cap": 999            // 2026-10-15 新增
    }
    // zhiji, cangwang …
  ],
  "free": {                       // 2026-10-15 新增：無牒的同一組數字（plans 表沒有 free 那一列）
    "casts": 2, "followups": 2, "chats": 15,
    "memories": 6, "pins": 0, "threads": 1,
    "favor_cap": 299
  },
  "current": "free",
  "plan_until": null,
  "subscription": null,
  "payable": false
}
```

舊後端沒有 `free` 與 `favor_cap`——缺的時候照舊畫，不在前端抄一份額度表。

## 方案頁要補的（b89 之後）

1. **道緣不封頂寫進賣點。** b89 已在閒聊撞頂時提示「入觀持牒，緣分才會再往前」，
   但方案頁沒有這一條，使用者點進來找不到那句話指的是什麼。
   `p.favor_cap > free.favor_cap` 時加一行：`閒聊道緣不封頂（無牒聊到 ${free.favor_cap} 為止）`。
2. **每格寫出與無牒的差。** 有 `free` 時，起卦／追問／閒聊三行寫成
   `每日閒聊 <b>25</b> 句（無牒 15）`。不寫對照，使用者不知道多了多少；
   2026-10-08 那次無牒 8→15，觀微還停在 12，就是因為沒有人並排看。
3. 0058 的 blurb 只講起卦與追問，沒提攻略線（道緣、記憶）。改文案走 `update plans set blurb`，不必出版。
