// dev/tts-quota-test.mts — 朗讀計費的規則測試。
//
// 這是整條線上唯一擋住 TTS 帳單的那道門，所以驗的是承諾而不是實作：
// 最高階每月有免費次數、其餘一律單次扣靈石、免費次數先用完才動靈石、
// 扣不到錢就不合成、命中快取不收費（那一條在 speakSource 裡，這裡驗它
// 依賴的算術）、台北日界不是 UTC 日界（以前是，等於每日重置在早上八點）。
//
// 【為什麼不是字數額度了】原本四階各給 5000／12000／30000／60000 字。
// 那個做法的致命處不是數字訂得高低，是「字數在畫面上不是資訊」——
// 沒有人知道 3200 字是多少東西，所以沒有人會省著用，只會某天突然撞牆。
// 現在是「本月還剩 N 次免費」與「這一次要 66 顆」，兩句都看得懂。
//
// tts.ts 載入時就讀 Deno.env，所以先擺一個替身再動態載入——
// 這一支要能在 node 上跑。
//
// 跑法：node dev/tts-quota-test.mts

import { fakeDb } from "./fake-db.mts";

(globalThis as any).Deno = { env: { get: () => undefined } };

const {
  CHARS_PER_READING, MAX_CHARS_PER_READING, DAILY_READING_CAP,
  taipeiToday, monthRange, ttsQuota, ttsFreeOf, spendReading,
} = await import("../supabase/functions/_shared/tts.ts");
const { COST } = await import("../supabase/functions/_shared/prices.ts");

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.stack ?? e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";

/** 一個帶著方案表與一名使用者的空資料庫。lingshi 預設給足，要測不足再自己壓低。 */
const dbWith = (lingshi = 1000) => fakeDb({
  profiles: [{ id: U, lingshi }],
  plans: [
    { id: "guanwei",  tts_free_readings: 0 },
    { id: "zhiji",    tts_free_readings: 0 },
    { id: "cangwang", tts_free_readings: 8 },
  ],
  tts_usage: [],
});
/** 直接寫一列日用量，當作「他那天念了這麼多」 */
const used = (db: any, day: string, readings: number, free = readings) =>
  db.from("tts_usage").insert({ user_id: U, day, chars: readings * CHARS_PER_READING, readings, free_readings: free });

console.log("\n朗讀計費\n");

console.log("— 免費次數只給最高階");
await t("只有藏往有免費次數，其餘階一律 0", async () => {
  const db = dbWith();
  eq(await ttsFreeOf(db, "cangwang"), 8, "藏往");
  eq(await ttsFreeOf(db, "zhiji"), 0, "知幾");
  eq(await ttsFreeOf(db, "guanwei"), 0, "觀微");
  eq(await ttsFreeOf(db, "free"), 0, "無牒");
});
await t("不認得的方案當作沒有免費次數，不是當作最高階", async () => {
  // 往嚴的那一邊倒：多扣了靈石使用者會回報，免費放行沒有人會回報。
  eq(await ttsFreeOf(dbWith(), "沒這一階"), 0, "認不得就該當 0");
});

console.log("\n— 免費次數先用完，才動靈石");
await t("藏往頭幾次不扣靈石", async () => {
  const db = dbWith(1000);
  const r = await spendReading(db, U, "cangwang", 1300);
  ok(r.ok, "該放行");
  eq((r as any).free, true, "該走免費次數");
  eq((r as any).paid, 0, "不該扣靈石");
  eq(db._store.profiles[0].lingshi, 1000, "餘額必須原封不動");
});
await t("藏往用完八次之後開始扣靈石", async () => {
  const db = dbWith(1000);
  await used(db, taipeiToday(), 8);            // 本月免費次數用盡
  const q = await ttsQuota(db, U, "cangwang");
  eq(q.free_left, 0, "免費次數該歸零");
  const r = await spendReading(db, U, "cangwang", 1300);
  ok(r.ok, "有靈石就該放行");
  eq((r as any).free, false, "不該再算免費");
  eq(db._store.profiles[0].lingshi, 1000 - COST.tts_reading, "該照價扣");
});
await t("其餘階第一次就扣靈石", async () => {
  for (const plan of ["free", "guanwei", "zhiji"]) {
    const db = dbWith(1000);
    const r = await spendReading(db, U, plan, 1300);
    ok(r.ok, `${plan} 該放行`);
    eq((r as any).free, false, `${plan} 不該有免費次數`);
    eq(db._store.profiles[0].lingshi, 1000 - COST.tts_reading, `${plan} 該照價扣`);
  }
});

console.log("\n— 扣不到錢就不合成");
await t("靈石不足時擋下來，且餘額原封不動", async () => {
  const db = dbWith(COST.tts_reading - 1);
  const r = await spendReading(db, U, "free", 1300);
  eq(r.ok, false, "扣不動就該擋");
  eq(db._store.profiles[0].lingshi, COST.tts_reading - 1, "擋下來餘額必須原封不動");
  eq(db._store.tts_usage.length, 0, "擋下來不該留用量紀錄");
});
await t("擋下來時講得出「要幾顆／你有幾顆」", async () => {
  const db = dbWith(3);
  const r = await spendReading(db, U, "free", 1300) as any;
  ok(String(r.msg).includes(String(COST.tts_reading)), `訊息要說要幾顆：${r.msg}`);
  ok(String(r.msg).includes("3"), `訊息要說你有幾顆：${r.msg}`);
});
await t("最高階被擋時的說法不一樣——他該知道免費次數是用完了，不是沒有", async () => {
  const db = dbWith(3);
  await used(db, taipeiToday(), 8);
  const r = await spendReading(db, U, "cangwang", 1300) as any;
  ok(String(r.msg).includes("免費"), `藏往的訊息該提到免費次數：${r.msg}`);
});

console.log("\n— 煞車（不是額度）");
await t("一天念太多次就停下來", async () => {
  const db = dbWith(100000);
  await used(db, taipeiToday(), DAILY_READING_CAP, 0);
  const r = await spendReading(db, U, "free", 1300);
  eq(r.ok, false, "撞到日上限該擋");
  eq(db._store.profiles[0].lingshi, 100000, "擋下來不該扣錢");
});
await t("異常長的一段不會一次燒掉十次的錢", () => {
  ok(MAX_CHARS_PER_READING >= CHARS_PER_READING * 2,
    `單次上限（${MAX_CHARS_PER_READING}）要容得下一篇正常批文（約 ${CHARS_PER_READING} 字）還有餘裕`);
  ok(MAX_CHARS_PER_READING <= CHARS_PER_READING * 5,
    `單次上限（${MAX_CHARS_PER_READING}）太鬆，等於沒有防呆`);
});

console.log("\n— 記帳");
await t("字數仍然要記——帳單是照字數出的", async () => {
  const db = dbWith();
  await spendReading(db, U, "free", 777);
  const row = db._store.tts_usage[0];
  eq(row.chars, 777, "字數");
  eq(row.readings, 1, "次數");
  eq(row.free_readings, 0, "免費次數");
});
await t("同一天念第二次是累加，不是覆蓋", async () => {
  const db = dbWith();
  await spendReading(db, U, "free", 100);
  await spendReading(db, U, "free", 200);
  eq(db._store.tts_usage.length, 1, "同一天該只有一列");
  eq(db._store.tts_usage[0].chars, 300, "字數該累加");
  eq(db._store.tts_usage[0].readings, 2, "次數該累加");
});
await t("扣款在 ledger 留得下痕跡（客服要查得到）", async () => {
  const db = dbWith();
  await spendReading(db, U, "free", 1300);
  const row = db._store.ledger.find((r: any) => r.action === "tts");
  ok(row, "ledger 裡找不到 tts 那一筆——使用者問「我的靈石去哪了」時答不出來");
  eq(row.amount, -COST.tts_reading, "金額");
});

console.log("\n— 月界與日界");
await t("下個月一號重新計算", async () => {
  const db = dbWith();
  const { from } = monthRange(taipeiToday());
  // 上個月的最後一天念滿八次，不該影響這個月
  const prev = new Date(Date.parse(from) - 86400000).toISOString().slice(0, 10);
  await used(db, prev, 8);
  const q = await ttsQuota(db, U, "cangwang");
  eq(q.free_left, 8, "上個月的用量不該算進這個月");
});
await t("日界走台北，不是 UTC", () => {
  // 台北 2026-03-02 01:00 ＝ UTC 2026-03-01 17:00。以 UTC 算會少一天。
  eq(taipeiToday(new Date("2026-03-01T17:00:00Z")), "2026-03-02", "台北日界");
  eq(taipeiToday(new Date("2026-03-01T15:59:00Z")), "2026-03-01", "台北日界前一刻");
});
await t("月範圍跨年不會算錯", () => {
  const r = monthRange("2026-12-15");
  eq(r.from, "2026-12-01", "起");
  eq(r.to, "2027-01-01", "迄——十二月的下一個月是明年一月");
});

console.log("\n— 定價與成本");
await t("一次朗讀的靈石定價不低於成本", () => {
  // MiniMax speech-2.8-hd 約 US$0.10／千字、匯率 32 → 一篇批文 NT$4.16。
  // 靈石的錨點是起卦：NT$0.63 ÷ 10 顆 ＝ 0.063／顆。
  const twdPerReading = 0.10 * (CHARS_PER_READING / 1000) * 32;
  const anchor = 0.63 / 10;
  const atCost = twdPerReading / anchor;
  console.log(`     成本 NT$${twdPerReading.toFixed(2)}／次 → 成本價 ${atCost.toFixed(0)} 顆，現價 ${COST.tts_reading} 顆`);
  if (COST.tts_reading < atCost * 0.95) {
    throw new Error(
      `現價 ${COST.tts_reading} 顆低於成本價 ${atCost.toFixed(0)} 顆——朗讀是要做成純收益的，` +
      `定得比成本低的話，念得越多的人虧越多。\n` +
      `       若已改用 turbo 模型（成本約降四成），把這條測試裡的 0.10 一併改掉。`);
  }
});
await t("最高階的免費次數不會貴過方案本身", async () => {
  const free = await ttsFreeOf(dbWith(), "cangwang");
  const twd = free * 0.10 * (CHARS_PER_READING / 1000) * 32;
  console.log(`     藏往 ${free} 次／月 ≈ NT$${twd.toFixed(0)}／月`);
  ok(twd < 100, `藏往的免費朗讀每月 NT$${twd.toFixed(0)}——那是方案裡唯一不論訂價都照燒的一項`);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 過 / ${fail} 敗\n`);
process.exit(fail === 0 ? 0 : 1);
