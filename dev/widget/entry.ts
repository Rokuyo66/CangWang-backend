// dev/widget/entry.ts — 桌面小工具原型（三種尺寸 × 五套配色 × 五種狀態）
//
// 這是給人看的原型，不是產品程式：它不連伺服器、不登入、不寫任何一列，
// 但它畫出來的每一個字都是真的算出來的——干支走 core.ts、節氣走 jieqi.ts、
// 行止走 widget.ts 的 STANCE、籤詩走 qian60.ts。所以在這裡看到的樣子，
// 就是 mode:"widget" 回什麼、前端照著畫會長什麼樣。
//
// 唯一「假」的是狀態切換器：等第與簽到與否用選的，因為那要一支真的日運卦才有。
//
// 配色表在這裡而不在後端：後端只管「這一套鎖沒鎖」（owned_themes），
// 色票是純前端的事。要換色改這一張 PALETTES 就好，不必動任何一支 function。
//
// 跑法：node dev/build-widget.mjs → 用瀏覽器開 dev/widget.html

import { dayGZi, gzName, monthGZi, xunKong, yearGZi } from "../../supabase/functions/_shared/core.ts";
import { jieqiOf } from "../../supabase/functions/_shared/jieqi.ts";
import { pickQian, TIER_LABEL } from "../../supabase/functions/_shared/qian60.ts";
import type { QianTier } from "../../supabase/functions/_shared/qian60.ts";
import { stanceOf, themeList } from "../../supabase/functions/_shared/widget.ts";

/* ---------- 配色 ----------
   五套：內建二（宣紙、夜觀）＋ 付費三（竹簡、硃砂、青花）。
   色票不是這裡定的——直接抄自前端 src/part1.html 的 :root 與 [data-theme=…]，
   每套只覆寫那 13 個變數。小工具貼在桌面上與 App 並排看得到，
   自己另配一套「像那個顏色」的近似色，兩邊擺在一起就會像兩個 App。

   對應：card ← --paper（App 的紙面）／stage ← --paper-2（襯在後面的桌布）
        line ← --paper-edge　ink ← --ink　dim ← --ink-faint
        gold ← --gold　seal ← --cinnabar（青花那套的 --cinnabar 是鈷藍，照收不改）

   材質是小工具自己加的一層：竹簡沒有那道直紋就只是一張綠紙，
   而配色要賣得掉，靠的正是「一眼看得出是哪一套」。 */
interface Palette {
  mode: "light" | "dark";
  stage: string; card: string; line: string;
  ink: string; dim: string; gold: string; seal: string;
  texture?: string;
}

const PALETTES: Record<string, Palette> = {
  paper: { mode: "light", stage: "#EBE1CC", card: "#F2EBDA", line: "#E0D4B8",
    ink: "#221E1A", dim: "#8A7E6C", gold: "#9A7B3F", seal: "#B5402E" },
  night: { mode: "dark", stage: "#1D1914", card: "#15120E", line: "#2A2218",
    ink: "#ECE3D1", dim: "#857B68", gold: "#C9A45C", seal: "#D86A52" },
  bamboo: { mode: "light", stage: "#D3D9BC", card: "#E4E7D3", line: "#AEBB92",
    ink: "#12210F", dim: "#6E8455", gold: "#5C8A2E", seal: "#96421F",
    texture: "repeating-linear-gradient(90deg, rgba(18,33,15,.13) 0 1.5px, rgba(0,0,0,0) 1.5px 27px)" },
  cinnabar: { mode: "dark", stage: "#38100D", card: "#220907", line: "#4E1A15",
    ink: "#FAE2E0", dim: "#A2756E", gold: "#E0913F", seal: "#E34234",
    texture: "radial-gradient(120% 90% at 80% 0%, rgba(227,66,52,.20), rgba(0,0,0,0) 60%)" },
  porcelain: { mode: "light", stage: "#DEE8F5", card: "#F5F8FC", line: "#A6BFDF",
    ink: "#001F52", dim: "#5878A8", gold: "#2A6BB8", seal: "#003DA5",
    texture: "repeating-linear-gradient(63deg, rgba(0,31,82,.05) 0 1px, rgba(0,0,0,0) 1px 46px), repeating-linear-gradient(-51deg, rgba(0,31,82,.04) 0 1px, rgba(0,0,0,0) 1px 63px)" },
};

const PRICES = { bamboo: 260, cinnabar: 260, porcelain: 320 };

/* ---------- 假狀態（原型才有；上線時由 mode:"widget" 回） ---------- */
const st = {
  theme: "paper",
  owned: ["bamboo"] as string[],   // 這個帳號在 App 裡解了竹簡，所以小工具選得到竹簡
  signed: false,
  tier: null as QianTier | null,   // null＝今日未測
  assetBase: "",                   // 節氣圖根目錄；原型手上沒有圖，留空走退路
};

/* ---------- 真資料：干支、節氣、籤 ---------- */
const now = new Date(Date.now() + 8 * 3600_000);
const [Y, M, D] = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
const dIdx = dayGZi(Y, M, D);
const GZ = {
  year: gzName(yearGZi(Y, M, D).idx), month: gzName(monthGZi(Y, M, D)),
  day: gzName(dIdx), kong: xunKong(dIdx),
};
const JQ = jieqiOf(Y, M, D);

const el = (tag: string, cls?: string, text?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let lastAction = "";
const fire = (label: string, link: string) => {
  lastAction = `${label} → ${link}`;
  paint();
};

/* ---------- 一張小工具 ---------- */
function widget(size: "s" | "m" | "l"): HTMLElement {
  const pal = PALETTES[st.theme];
  const box = el("div", `w w-${size} ${pal.mode}`);
  const v = box.style as unknown as CSSStyleDeclaration & { setProperty(k: string, x: string): void };
  v.setProperty("--card", pal.card);
  v.setProperty("--line", pal.line); v.setProperty("--ink", pal.ink);
  v.setProperty("--dim", pal.dim); v.setProperty("--gold", pal.gold);
  v.setProperty("--seal", pal.seal);
  v.setProperty("--texture", pal.texture ?? "none");

  // 節氣襯底：有圖就用節氣包那張貼紙，沒有圖退成節氣二字的大字。
  // 退路不是應急——小工具可能跑在還沒下載資產的機器上，那時也不能開天窗。
  const bg = el("div", "bg");
  if (st.assetBase && JQ.asset) {
    const img = document.createElement("img");
    img.src = `${st.assetBase}/${JQ.asset}.webp`;
    img.onerror = () => { img.remove(); bg.appendChild(el("div", "bgword", JQ.name)); };
    bg.appendChild(img);
  } else {
    bg.appendChild(el("div", "bgword", JQ.name));
  }
  box.appendChild(bg);

  const body = el("div", "body");
  box.appendChild(body);

  // ① 農民曆小字：干支年月日 ＋ 節氣。國曆一個字都不寫——系統時鐘早就寫過了。
  const top = el("div", "top");
  top.appendChild(el("span", "gz", `${GZ.year}年${GZ.month}月${GZ.day}日`));
  top.appendChild(el("span", "jq", size === "s" ? JQ.name : `${JQ.name}·第${JQ.dayIndex}日`));
  body.appendChild(top);

  // ② 主體：未測＝引導去測；已測＝行止。
  //    中段吃掉剩下的高度並靠下對齊——桌面小工具的高度是系統給死的，
  //    內容自己撐開只會把底列擠出畫面外（而使用者不會捲動一個小工具）。
  const mid = el("div", "mid");
  body.appendChild(mid);

  if (st.tier == null) {
    mid.appendChild(el("div", "u-word", "未測"));
    if (size !== "s") mid.appendChild(el("div", "u-line", "今日的氣還沒測——先抽一卦，才知道是宜守還是且行。"));
    const b = el("button", "cta", "測今日運勢 ›");
    b.onclick = () => fire("測今日運勢", "cangwang://fortune?from=widget");
    mid.appendChild(b);
  } else {
    const s2 = stanceOf(st.tier);
    const q = pickQian(st.tier, GZ.day, GZ.day[1]);   // 原型：以日支代世爻，取一支同等第的籤
    const head = el("div", "head");
    head.appendChild(el("div", "stance", s2.label));
    // 等第徽章只在它與行止不同字時才掛：宜守那一級兩者同名，
    // 掛上去就是同一個詞在同一行講兩次。
    if (size !== "s" && TIER_LABEL[st.tier] !== s2.label) head.appendChild(el("div", "tier", TIER_LABEL[st.tier]));
    mid.appendChild(head);
    // 小尺寸只放「宜」：那是三個詞就能看完的東西，而一句話不是。
    if (size === "s") {
      mid.appendChild(el("div", "yj", "宜 " + s2.yi.join("　")));
    } else {
      mid.appendChild(el("div", "line", s2.line));
    }
    if (size === "l") {
      const yj = el("div", "yj");
      yj.appendChild(el("span", "yi", "宜 " + s2.yi.join("　")));
      yj.appendChild(el("span", "ji", "忌 " + s2.ji.join("　")));
      mid.appendChild(yj);
      const poem = el("div", "poem");
      poem.appendChild(el("div", "qn", `第${q.n}籤　${q.gz}　${q.allusion}`));
      q.poem.forEach((ln) => poem.appendChild(el("div", "pl", ln)));
      mid.appendChild(poem);
    }
  }

  // ③ 底列：簽到 ＋ 問卦。問卦鈕永遠在、永遠最顯眼，且不標剩餘次數。
  const foot = el("div", "foot");
  const sign = el("button", "sign" + (st.signed ? " on" : ""),
    st.signed ? (size === "s" ? "已簽" : "已簽到") : (size === "s" ? "簽到" : "今日簽到"));
  sign.onclick = () => { st.signed = true; fire("簽到", "cangwang://signin?from=widget"); };
  foot.appendChild(sign);
  const ask = el("button", "ask", "問　卦");
  ask.onclick = () => fire("問卦", "cangwang://cast?from=widget");
  foot.appendChild(ask);
  body.appendChild(foot);

  return box;
}

/* ---------- 控制列（原型專用） ---------- */
function controls(): HTMLElement {
  const bar = el("div", "ctl");

  const g1 = el("div", "grp");
  g1.appendChild(el("span", "lab", "配色"));
  for (const th of themeList(st.owned, PRICES)) {
    const b = el("button", "chip" + (st.theme === th.key ? " on" : "") + (th.locked ? " lock" : ""),
      th.locked ? `${th.name}　${th.price}` : th.name);
    b.title = th.locked ? `未解鎖：App 內以 ${th.price} 靈石買斷後，小工具才選得到` : "";
    b.onclick = () => {
      // 付費牆：App 裡沒解鎖的，小工具也不給用。原型照樣擋，才看得出擋起來長什麼樣。
      if (th.locked) { lastAction = `「${th.name}」尚未解鎖 → cangwang://shop?theme=${th.key}`; paint(); return; }
      st.theme = th.key; paint();
    };
    g1.appendChild(b);
  }
  bar.appendChild(g1);

  const g2 = el("div", "grp");
  g2.appendChild(el("span", "lab", "今日運勢"));
  const states: [string, QianTier | null][] = [
    ["未測", null], ["大吉", "daji"], ["吉", "ji"], ["平", "ping"], ["宜守", "shou"],
  ];
  for (const [name, tier] of states) {
    const b = el("button", "chip" + (st.tier === tier ? " on" : ""), name);
    b.onclick = () => { st.tier = tier; paint(); };
    g2.appendChild(b);
  }
  bar.appendChild(g2);

  const g3 = el("div", "grp");
  g3.appendChild(el("span", "lab", "簽到"));
  const b3 = el("button", "chip" + (st.signed ? " on" : ""), st.signed ? "已簽" : "未簽");
  b3.onclick = () => { st.signed = !st.signed; paint(); };
  g3.appendChild(b3);
  bar.appendChild(g3);

  return bar;
}

/* ---------- 畫 ---------- */
const root = document.getElementById("app")!;

function paint() {
  root.textContent = "";
  root.appendChild(el("h1", "", "蒼望桌面小工具"));
  root.appendChild(el("p", "sub",
    `原型。干支、節氣、籤詩皆為今日實算；等第與簽到為手動切換。旬空 ${GZ.kong}。`));
  root.appendChild(controls());

  const stage = el("div", "stage");
  (stage.style as CSSStyleDeclaration).background = PALETTES[st.theme].stage;
  for (const [size, cap] of [["s", "小　2×2"], ["m", "中　4×2"], ["l", "大　4×4"]] as const) {
    const cell = el("div", "cell");
    cell.appendChild(widget(size));
    cell.appendChild(el("div", "cap", cap));
    stage.appendChild(cell);
  }
  root.appendChild(stage);

  root.appendChild(el("div", "act", lastAction ? "點擊：" + lastAction : "點擊小工具上的鈕，這裡會顯示它要開的深連結。"));
  root.appendChild(el("p", "note",
    "問卦鈕不標剩餘次數（後端 mode:\"widget\" 不回額度）。節氣襯底走節氣包那 24 張貼紙；" +
    "原型手上沒有圖檔，退成節氣二字。"));
}

paint();
