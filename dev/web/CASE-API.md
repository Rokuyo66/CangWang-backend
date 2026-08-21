# 卦案後端 API（待接：前端 repo）

後端這一側已經完成並測過（`node dev/case-run-test.mts`，26 條）。這份是給前端的契約——
前端 repo（`CangWang-web`）目前零卦案畫面，`src/part2.html` 那格還是
`case: ()=>toast("卦案尚未開放，敬候觀中通告")`。要解鎖，就是把下面這幾支接起來，
把那一行換成開啟卦案畫面。

全部走既有的 `interpret` Edge Function，跟站內其他功能同一支 `callInterpret`：
`POST /functions/v1/interpret`，`Authorization: Bearer <JWT>`，body 帶 `mode`。
錯誤一律 200 ＋ `{kind:"err", msg:"…"}`（msg 是可以直接顯示給玩家的中文）。

---

## 這一版刻意沒有的東西

先看這一段，否則會照著原型的畫面接，然後發現有兩顆鈕接不上。

**沒有「重新起卦」。** 原型（`dev/play.html`）進案前可以一直重擲，那是除錯用的。
卦決定關鍵線索的取得代價（`access`），能重擲就等於玩家自己選難度，代價機制當場作廢。
所以 `case_start` 是「擲卦＋開局」一次做完，卦由伺服器擲，前端連送 lines 的欄位都沒有。
要換一支卦，就得把這一局結案——那一局會照實記成沒破案，那是它的代價。

**進行中的局刪不掉。** 同上：刪得掉就是重擲的後門。`case_delete` 只受理已結案的。

**同一案同時只有一局。** 第二次 `case_start` 不會開新局，會回原本那一局並帶 `resumed:true`。
前端不必自己記「我是不是已經進案了」，直接呼叫就好。

**畫面自己不算任何東西。** 時間、線索、擋住的理由、可選行動全由伺服器算好送下來，
前端照 `options` 畫按鈕、照 `region`／`log` 畫畫面即可。局內狀態不必存在前端。

---

## 六支 mode

| mode | 送 | 回 |
|---|---|---|
| `case_list` | — | `{cases, active, kept, kept_quota}` |
| `case_start` | `case_id`, `companion`（可 null） | 局面（見下）＋ `resumed` |
| `case_state` | `run_id` | 局面 |
| `case_action` | `run_id`, `action` | 局面 |
| `case_keep` | `run_id`, `keep`（預設 true） | `{run_id, kept, kept_quota}` |
| `case_delete` | `run_id` | `{run_id, deleted}` |

`companion` 是 `daoshi_m`／`daoshi_f`／`lingshou`，或 null＝獨自前往。

`action` 就是把 `options[i].action` 原樣送回來：

```js
{kind:"search"} | {kind:"move", to:3} | {kind:"inspect", objectId:"o_pit"}
{kind:"talk", npcId:"n_elder"} | {kind:"companion"} | {kind:"end"}
```

不在當下 `options` 裡的行動一律回 `{kind:"err", msg:"此刻做不到這件事"}`——
不是靜靜地沒反應。前端照 `options` 畫按鈕就不會踩到。

## 局面（`case_start`／`case_state`／`case_action` 的回應）

```js
{
  kind:"ok",
  run_id, case_id, title, question,
  companion, companion_name,          // "師兄"／"師妹"／"觀喵"／null
  minute, clock:"19:33", spent,       // 世界時間；spent＝進案至今花掉幾分鐘
  ended, kept,
  errand: null | { region, minutes_left },   // 同行外出中；region 只在他有說去哪時才是數字
  gua: {                              // 卦盤，整份都是卦推出來的，畫「看卦盤」那一頁用
    benName, bianName, palace, palaceDir, guaType, useQin,
    key:{ pos, hidden, flyPos, chuFu, wang, grade, … },
    support:{ yuanPos:[], jiPos:[], yuanActive, jiActive, jiStrong, … },
    shiYong, access, startPos, rivalPos, tempo, turnTo, turnDir, omens:[],
    regions:[ {pos,name,image,qin,zhi,wx,beast,mood,dir,roles,moving,anDong,flux,tags} ],
    map:[ {pos,name,image} ],         // 六區的名字，畫地圖／移動鈕用
  },
  region: null | {                    // 當前所在區；結案後為 null
    pos, name, image, dir, beast, mood,
    paragraphs:[],                    // 依當局投射組出的描述段落，照順序印
    roles:[], searched,
    objects:[ {id, name, seen, blocked} ],   // blocked 是「為什麼現在拿不到」，非 null 就顯示
    npcs:[ {id, name, talked} ],
  },
  options:[ {action, label, cost, note} ],   // 直接畫成按鈕；note 是「已看過」「他還有話」之類
  clues:{ held:[…], known:[…], known_total },
  log:[ {clock, kind, text} ],        // kind: move|search|inspect|talk|companion|gain|world|system
  review: null | { … },               // 只在 ended 時有
}
```

`review`：

```js
{ title, spent, clock, solved,
  companion, companion_finds, companion_total,
  found:[{id,name,kind,text,region}],
  lost:[{id,name}],                   // 因來遲而永久錯失
  missed_count,                       // 未發現的只給數量，畫成 ？？？
  gua:{ben,bian,palace,access,keyPos},
  truth: null | "…" }                 // 只有破案才有
```

## 下發過濾（前端不必自己防）

`truth`、`brief`、線索內文、物件 `desc`、NPC `voice`，在挖出來之前一概不下發——
過濾在 `_shared/case-run.ts` 的每一支 payload，是白名單挑欄位。
所以前端可以放心把整包 JSON 丟進 devtools，不會有人從那裡讀到真相。
物件的 `desc` 是查看之後才進 `log` 的，別去 `objects` 裡找。

## 記憶檔案

`case_keep` 封存，免費 1 格、付費 3 格（`kept_quota` 會告訴你幾格）。
滿格時回 `「記憶檔案已滿（N 格）。要留這一份，得先捨棄一份舊的。」`——
**不自動覆蓋**，要玩家自己選捨棄哪一份（`case_keep` 帶 `keep:false`，或 `case_delete`）。

---

## 前端要做的事

1. `src/part2.html` 那行 toast 換成開啟卦案畫面。
2. 卦案畫面：進案（選同行 → 進案）／局內（區域＋行動＋日誌）／結案回顧三頁。
   原型的版面在後端 repo `dev/shared/play-ui.ts`，但那是桌機兩欄（`1fr 320px`），
   手機要重排成直式——行動列收進底部抽屜，日誌可捲，卦盤另開一頁。
3. 立繪套 `st-` 那套滿版比例（`src/styles/story.css` 已經是改好的版本），
   卦案自己那份 `pv-` 樣式在公司機的 `dev/web/entry.ts`，補丁見 `PORTRAIT-FULLBLEED.md`。
4. `appBuild` +1 再出 APK。
