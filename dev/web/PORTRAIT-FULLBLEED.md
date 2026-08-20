# 卦案立繪改滿版鋪底（待套用：公司機）

劇情事件（前端 repo `src/styles/story.css`）那一版已經改完並量過，這裡是卦案的同一套。
卦案的樣式源頭是 `dev/web/entry.ts` 裡 `injectStyle()` 注入的那段 `#pv-style`，
只在公司機上，家用機兩個 repo 都沒有，所以先寫成補丁。

版面比例照六六給的版面參考圖，以 1200 高的畫布換算：
名條 `70/1200 ≈ 5.8%`、內文按鈕區 `600/1200 = 50%`。
兩個數字是全部的版面決定，其餘規則都從它們推出去。

---

## 0) markup：遮罩要排在立繪之後

現在的順序是 `pv-veil` → `pv-stage`。兩者都沒有 z-index，先後由 DOM 決定；
立繪一旦鋪滿，就會蓋在遮罩上面，字底下那層暗角等於失效。

```diff
       <div class="pv-bg" id="pvBgB"></div>
-      <div class="pv-veil"></div>
       <div class="pv-stage"><div class="pv-portrait" id="pvPort"></div></div>
+      <div class="pv-veil"></div>
       <div class="pv-hud" id="pvHud"></div>
```

## 1) 版面變數：加進 `.pv{...}` 那一塊

```css
  /* ══ 版面比例（版面參考圖，以 1200 高的畫布換算）══
     名條 70/1200 ≈ 5.8%、內文按鈕區 600/1200 = 50%。
     要調高低只改這兩行，立繪、遮罩、對話框自己會跟著讓位。
     若改以美術規格的 1280×1920 為基準，對應值是 3.6dvh / 31dvh。 */
  --pv-name-h:clamp(46px, 5.8dvh, 70px);
  --pv-box-h:min(50dvh, 440px);
  --pv-deck-h:calc(var(--pv-name-h) + var(--pv-box-h));
```

## 2) 遮罩：只留上緣壓黑與景深

字底下要多暗改由 `.pv-box` 自己負責（見 4）——它跟著框高走，
dvh 怎麼變都對得準；寫在整層遮罩上就得跟著猜百分比，框高一改要重猜一次。

```css
/* 舊 */
.pv-veil{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(to bottom,rgba(11,9,6,.55) 0%,rgba(11,9,6,.12) 34%,rgba(11,9,6,.86) 74%,#0b0906 100%)}

/* 新 */
.pv-veil{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(to bottom,rgba(11,9,6,.58) 0%,rgba(11,9,6,.08) 22%,
                             rgba(11,9,6,.08) 68%,rgba(11,9,6,.38) 100%)}
```

## 3) 立繪：整層鋪滿

```css
/* 舊 */
.pv-stage{position:absolute;left:0;right:0;top:8%;bottom:44%;
  display:flex;align-items:flex-end;justify-content:center;pointer-events:none}
.pv-portrait{height:100%;aspect-ratio:3/4;max-width:60%;opacity:0;transition:opacity .4s ease;
  display:flex;align-items:center;justify-content:center}
.pv-portrait.on{opacity:1}
.pv-portrait img{height:100%;width:100%;object-fit:contain;object-position:bottom}
.pv-portrait.miss{border:1px dashed rgba(200,168,107,.28);border-radius:3px;
  background:linear-gradient(180deg,rgba(40,32,24,.5),rgba(20,16,11,.5))}

/* 新 */
.pv-stage{position:absolute;inset:0;pointer-events:none}
.pv-portrait{position:absolute;inset:0;overflow:hidden;
  opacity:0;transition:opacity .4s ease}
.pv-portrait.on{opacity:1}
/* --pv-por-y 是 cover 的縱向裁切基準；臉偏高偏低的圖各自微調，不必動版面。 */
.pv-portrait img{display:block;width:100%;height:100%;
  object-fit:cover;object-position:50% var(--pv-por-y,6%)}
/* 缺圖不要跟著鋪滿：整片虛線框等於在畫面上蓋一張網，
   而且現在每一局都缺圖（art/ 只有 README），常態不能長這樣。
   維持原本那個「站在對話框上方」的框，只是改吃 --pv-deck-h。 */
.pv-portrait.miss{top:10%;bottom:calc(var(--pv-deck-h) + 12px);
  left:50%;right:auto;transform:translateX(-50%);width:min(60%,46dvh);
  display:flex;align-items:center;justify-content:center;
  border:1px dashed rgba(200,168,107,.28);border-radius:3px;
  background:linear-gradient(180deg,rgba(40,32,24,.5),rgba(20,16,11,.5))}

/* 寬螢幕（桌機／平板）：cover 改由寬度決定縮放，900×1200 會被放大到只剩胸口以上。
   收成圖本身的比例置中站著就一刀不裁，兩側交還給背景。
   限 min-height:700px：橫置手機也符合寬比例，但那裡高度只有 375px，
   收成直式後整個人幾乎都被對話框蓋住，反而是保留特寫好看。 */
@media(min-aspect-ratio:3/4) and (min-height:700px){
  .pv-portrait{left:50%;right:auto;transform:translateX(-50%);width:calc(100dvh * .75)}
}
```

## 4) 對話框與名條

```css
/* 舊 */
.pv-box{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 18px 22px;
  height:42%;min-height:270px;display:flex;flex-direction:column;justify-content:flex-end}
.pv-speaker{display:inline-block;font-size:13px;letter-spacing:.18em;color:var(--gold);
  border-bottom:1px solid rgba(200,168,107,.35);padding-bottom:5px;margin-bottom:11px}

/* 新 */
.pv-box{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 18px 22px;
  height:var(--pv-deck-h);display:flex;flex-direction:column;justify-content:flex-end;
  /* 字底下的暗度綁在框身上，不綁在整層遮罩。上緣留透明，
     才不會在立繪身上切出一條硬邊。 */
  background:linear-gradient(to bottom,rgba(11,9,6,0) 0%,rgba(11,9,6,.55) 11%,
             rgba(11,9,6,.86) 34%,rgba(11,9,6,.95) 100%)}
/* 名條橫貫整寬：負邊距抵銷 .pv-box 的 18px 左右內距（兩者要一起改）。 */
.pv-speaker{display:flex;align-items:center;justify-content:center;
  height:var(--pv-name-h);margin:0 -18px 14px;padding:0 18px;
  font-size:15px;letter-spacing:.28em;color:#e8e0d2;text-align:center;
  text-shadow:0 1px 4px rgba(0,0,0,.7);
  background:linear-gradient(to right,rgba(11,9,6,0) 0%,rgba(24,18,12,.78) 14%,
             rgba(24,18,12,.78) 86%,rgba(11,9,6,0) 100%);
  border-top:1px solid rgba(200,168,107,.30);
  border-bottom:1px solid rgba(200,168,107,.30)}
```

`min-height:270px` 拿掉是有意的：框高改由 dvh 決定之後再壓一個 px 下限，
矮螢幕上兩個規則會互相打架（`--pv-box-h` 已經有 `min()` 上限，下限交給斷點）。

## 5) 手機斷點

```css
/* 舊 */
@media(max-width:520px){
  .pv-text{font-size:15px;line-height:1.95}
  .pv-box{height:46%;min-height:250px}
  .pv-stage{bottom:48%}
  ...

/* 新 */
@media(max-width:520px){
  .pv-text{font-size:15px;line-height:1.95}
  .pv-speaker{font-size:14px;letter-spacing:.22em}
  ...
}
/* 矮螢幕：內文區佔比放大，否則三行字就開始捲。立繪是鋪底的，不必再各寫一套尺寸。 */
@media(max-height:760px){ .pv{--pv-box-h:min(56dvh,430px)} }
@media(max-height:560px){ .pv{--pv-name-h:38px;--pv-box-h:min(72dvh,330px)} }
```

（`.pv-stage{bottom:48%}` 整條刪掉——stage 現在是滿版的。）

---

## 套完要量的四件事

前端那版是這樣驗的，量的是數字不是感覺（375×812）：

1. 立繪層 = 375×812 滿版，名條 47px，框高 453 = 47 + 406。
2. `document.documentElement.scrollWidth - innerWidth === 0`（無水平溢出）。
3. 375×667（iPhone SE）：三個選項時內文區剩 112px，還不該捲到看不見。
4. 1280×800：立繪層 600×800 置中、`cropX === 0 && cropY === 0`。

## 給美術的一條規格（實測得出）

900×1200 的立繪在 375 寬的手機上，左右各裁掉約 19%（cover 由高度決定縮放）。
**人物主體要落在畫面中央 60% 以內**，超出的部分在手機上一定看不到。
`art/README.md` 的立繪那一列值得補這句。
