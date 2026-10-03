# 回評反芻與追問反問：前端要知道的事

後端 0078 起，回評之後系統會自己回頭想「這卦錯在哪」，結果分三層生效（程式與理由見
`supabase/functions/_shared/reflect.ts` 檔頭）。前端**不需要改任何東西也能跑**，
下面列出可以接的新欄位。

## 一、追問（`mode: "followup"`）回應多三個欄位

| 欄位 | 型別 | 意思 |
|---|---|---|
| `ask` | `string \| null` | 角色在這一答末尾向他反問的那一句。**已經接在 `answer` 末尾**，舊畫面照畫 `answer` 就看得到；要另畫樣式時，從 `answer` 尾端切掉這一句再單獨畫。 |
| `waived` | `boolean` | 這一次追問是在回答上一句反問，**不收費、不吃當日免費額度**。 |
| `revised` | `boolean` | 這一答依他的回答修正了首解的前提（正文開頭會明說「修正」）。可以加個小標記。 |

建議：`ask` 不為 null 時，追問輸入框的按鈕改成「回答（不耗額度）」——下一次送出就是免費的。
一卦最多反問 2 次（`MAX_ASKS_PER_CAST`），之後就不會再出現 `ask`。

## 二、卦詳情（`mode: "cast_detail"`）

`followups[]` 每一列多兩個欄位：`ask`（同上）、`revised`（布林）。

## 三、回評（`mode: "review"`）

回應不變。送出後背景會跑一次反省（約 5–15 秒，不影響回應時間）。
只改「公開與否」不會重跑；改了準不準或心得才會。

## 四、後台：看判法輕重

Supabase SQL Editor：

```sql
select * from rule_priority_report;
```

- 全站已印證的加權樣本未滿 30 次前，所有判法都是「常規」（整套分級不啟動）。
- 單條判法要累積 8 次以上、且統計上顯著偏離全站基準，才會被調成「降級」或「優先」。
- 想手動定某一條：`update rule_priority set tier = -1, locked = true where rule_key = 'xunkong';`
  （`locked = true` 之後自動重算不會蓋掉；改回自動就設 `locked = false`。）

看單卦反省：

```sql
select c.question, r.verdict, r.attribution, r.analysis, r.counterfactual, r.lesson
  from cast_reflections r join casts c on c.id = r.cast_id
 order by r.created_at desc limit 20;
```

## 部署順序

1. 資料庫：跑 `0078_reflection.sql`（`dev/migrate.ps1`）
2. 程式：重新部署 `interpret` 與 `webhook-tg`

順序反了也不會壞（新程式讀不到新表會略過、追問存檔有兜底），只是反芻不會發生。
