// dev/widget-test.mts — 桌面小工具那一支（mode:"widget"）的狀態組裝。
//
// 為什麼要測這一段：小工具是「不會有人回報壞掉」的介面——它待在桌面角落，
// 顯示錯了多半只被當成今天運氣普通。所以三件會靜靜出錯的事在這裡釘死：
//   1. 未測 → 必須回 done:false 並帶引導句（回錯了會變成天天寫著同一個行止）；
//   2. 已測 → 等第是把今日那一卦的盤面重算出來的，不是另存的欄位；
//      撈不到那一卦時要老實回 tier:null，不能退回一個看起來很正常的「平」；
//   3. 沒解鎖的配色一定 locked——這是付費牆，前端照著畫，判斷錯就等於免費送。
//
// 跑法：node dev/widget-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { fakeDb } from "./fake-db.mts";
const { stanceOf, themeList, STANCE } = await import("../supabase/functions/_shared/widget.ts");
const { widgetState } = await import("../supabase/functions/_shared/widget-state.ts");
const { buildChart } = await import("../supabase/functions/_shared/core.ts");
const { fortuneTier } = await import("../supabase/functions/_shared/fortune.ts");
const { jieqiOf, jieqiAssetOf } = await import("../supabase/functions/_shared/jieqi.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) =>
  ok(a === b, `${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
const PRICES = { bamboo: 260, cinnabar: 260, porcelain: 320 };
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const nowUtc = new Date().toISOString();

console.log("\n桌面小工具狀態\n");

/* ---------- 行止 ---------- */

await t("四個等第各有一個行止，四個詞不重複", () => {
  const tiers = ["daji", "ji", "ping", "shou"] as const;
  const labels = tiers.map((x) => stanceOf(x).label);
  eq(labels.length, new Set(labels).size, "有兩個等第落在同一個詞上");
  eq(stanceOf("shou").label, "宜守", "最差一級要講宜守");
  eq(stanceOf("daji").label, "且行", "最好一級要講且行");
  for (const x of tiers) {
    ok(stanceOf(x).line.length > 10, `${x} 少了那句建議`);
    ok(stanceOf(x).yi.length > 0 && stanceOf(x).ji.length > 0, `${x} 的宜忌不該是空的`);
  }
});

await t("宜與忌不會撞字——同一天既宜又忌一件事，是農民曆的笑話", () => {
  for (const s of Object.values(STANCE)) {
    const dup = s.yi.filter((w: string) => s.ji.includes(w));
    eq(dup.length, 0, `${s.label} 的宜忌撞字：${dup.join("、")}`);
  }
});

/* ---------- 未測 ---------- */

await t("今日未測：回 done:false 並帶引導句，不給行止", async () => {
  const db = fakeDb({ profiles: [{ id: U, lingshi: 30, last_sign_date: null, sign_streak: 0, last_fortune_date: null, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.fortune.done, false, "沒測過卻說測了");
  ok((w.fortune as any).hint.includes("宜守") && (w.fortune as any).hint.includes("且行"), "引導句要點出這兩個詞，人才知道測完會拿到什麼");
  eq((w.fortune as any).stance, undefined, "未測不該有行止");
});

await t("昨日測過、今日未測＝未測", async () => {
  const y = new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  const db = fakeDb({ profiles: [{ id: U, last_fortune_date: y, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.fortune.done, false, "昨日的卦不該算成今日的");
});

/* ---------- 已測 ---------- */

const chartOf = (lines: number[]) => buildChart(lines, 2026, 9, 9, 10);

await t("今日已測：等第由今日那一卦的盤面重算，與 fortuneTier 一致", async () => {
  const chart = chartOf([7, 8, 7, 9, 8, 6]);
  const db = fakeDb({
    profiles: [{ id: U, last_fortune_date: today, owned_themes: ["bamboo"] }],
    casts: [{ id: "cast-1", user_id: U, category: "日運", chart, created_at: nowUtc }],
  }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.fortune.done, true, "測過卻說沒測");
  eq((w.fortune as any).tier, fortuneTier(chart).tier, "等第與 fortuneTier 算出來的不同");
  eq((w.fortune as any).stance.label, stanceOf(fortuneTier(chart).tier).label, "行止沒跟著等第走");
  eq((w.fortune as any).castId, "cast-1", "castId 要指得回那一卦，小工具點下去才進得了批文");
  eq((w.fortune as any).qian.poem.length, 4, "籤詩四句");
});

await t("正式問事的卦不會被當成日運", async () => {
  const db = fakeDb({
    profiles: [{ id: U, last_fortune_date: null, owned_themes: [] }],
    casts: [{ id: "cast-2", user_id: U, category: "感情", chart: chartOf([7, 7, 7, 7, 7, 7]), created_at: nowUtc }],
  }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.fortune.done, false, "問事卦被算成了今日運勢");
});

await t("閘門記了但卦撈不到：老實回 tier:null，不假造一個等第", async () => {
  const db = fakeDb({ profiles: [{ id: U, last_fortune_date: today, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.fortune.done, true, "閘門記了就是測過了");
  eq((w.fortune as any).tier, null, "撈不到盤面卻生出了等第");
  eq((w.fortune as any).stance, null, "撈不到盤面卻生出了行止");
});

/* ---------- 簽到與干支小字 ---------- */

await t("簽到狀態看的是台北今日", async () => {
  const db = fakeDb({ profiles: [{ id: U, last_sign_date: today, sign_streak: 5, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.sign.done, true, "今天簽了卻說沒簽");
  eq(w.sign.streak, 5, "連續天數沒帶出來");
});

await t("小字是干支不是國曆——年月日三格齊、且不含阿拉伯數字", async () => {
  const db = fakeDb({ profiles: [{ id: U, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.ganzhi.year.length, 2, "年干支要兩個字");
  eq(w.ganzhi.month.length, 2, "月干支要兩個字");
  eq(w.ganzhi.day.length, 2, "日干支要兩個字");
  eq(w.ganzhi.line, `${w.ganzhi.year}年${w.ganzhi.month}月${w.ganzhi.day}日`, "小字組不出農民曆那一行");
  ok(!/\d/.test(w.ganzhi.line), "小字裡混進了阿拉伯數字（國曆不該出現在這裡）");
  ok(!("date" in w) && !("today" in w), "回應裡不該夾帶國曆日期");
});

await t("節氣帶得出襯底圖資產鍵，24 個節氣一個都不缺", () => {
  const names = ["立春","雨水","驚蟄","春分","清明","穀雨","立夏","小滿","芒種","夏至","小暑","大暑",
    "立秋","處暑","白露","秋分","寒露","霜降","立冬","小雪","大雪","冬至","小寒","大寒"];
  const assets = names.map(jieqiAssetOf);
  ok(assets.every((a) => a.length > 0), "有節氣查不到襯底圖：" + names.filter((n) => !jieqiAssetOf(n)).join("、"));
  eq(assets.length, new Set(assets).size, "兩個節氣指到了同一張圖");
  ok(jieqiOf(2026, 9, 9).asset.length > 0, "jieqiOf 沒把 asset 帶出來");
});

/* ---------- 配色（付費牆） ---------- */

await t("沒解鎖的配色一律 locked，內建兩套永遠不鎖", () => {
  const list = themeList([], PRICES);
  const by = Object.fromEntries(list.map((x: any) => [x.key, x]));
  eq(by.xuan.locked, false, "宣紙是內建，不該鎖");
  eq(by.night.locked, false, "夜觀是內建，不該鎖");
  eq(by.bamboo.locked, true, "沒買竹簡卻給用了");
  eq(by.bamboo.price, 260, "價目要跟著出，前端才標得出解鎖條件");
});

await t("App 裡解了竹簡，小工具才給竹簡", () => {
  const by = Object.fromEntries(themeList(["bamboo"], PRICES).map((x: any) => [x.key, x]));
  eq(by.bamboo.locked, false, "買了卻還鎖著");
  eq(by.cinnabar.locked, true, "買竹簡不該連硃砂一起開");
});

await t("已買但已下架的配色仍在清單裡——買斷制，下架不等於收回", () => {
  const list = themeList(["oldink"], PRICES);
  const old = list.find((x: any) => x.key === "oldink");
  ok(old, "下架後那一套從小工具裡整個消失了");
  eq(old!.locked, false, "買過的卻鎖起來");
  eq(old!.price, null, "已下架就沒有價目可標");
});

await t("狀態裡的配色清單與 owned_themes 同一份事實", async () => {
  const db = fakeDb({ profiles: [{ id: U, owned_themes: ["porcelain"] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES });
  eq(w.themes.owned.join(), "porcelain", "owned 沒原樣帶出");
  eq(w.themes.list.find((x: any) => x.key === "porcelain")!.locked, false, "已解鎖卻鎖著");
  eq(w.themes.list.length, 5, "配色共五套（內建二＋付費三）");
});

await t("不回額度：問卦鈕上標不出剩幾卦", async () => {
  const db = fakeDb({ profiles: [{ id: U, owned_themes: [] }], casts: [] }) as any;
  const w = await widgetState(db, { userId: U, themePrices: PRICES }) as Record<string, unknown>;
  for (const k of ["castFreeLeft", "castFreePerDay", "chatFreeLeft", "followFreeLeft"]) {
    eq(k in w, false, `不該回 ${k}——桌面上先算帳會讓人不問`);
  }
});

console.log(`\n${fail ? "❌" : "✅"} ${pass} 過 ${fail} 失敗\n`);
process.exit(fail ? 1 : 0);
