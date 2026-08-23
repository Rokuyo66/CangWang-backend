// dev/billing-test.mts — 起卦計費與標價的規則測試。
//
// 為什麼要有這一支：標價與計費是兩段各自寫的程式碼，一旦讀的不是同一把額度、
// 同一條日界、同一個方案，畫面就會說「免費」而錢包默默少十顆——這種 bug 不會噴錯，
// 只會被人在事後發現。所以這裡驗的不是「扣得對不對」，而是
// 「按鈕上那個數字，跟按下去真正發生的事，是不是同一件事」。
//
// 跑法：node dev/billing-test.mts

// services.ts 在載入時就會讀 Deno.env（模型名、額度預設值），node 沒有這個全域，
// 先擺一個只會回 undefined 的替身，讓它全部走預設值。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { fakeDb } from "./fake-db.mts";
const { billCast, castFreeLeft, castFreeUsed, taipeiToday, linkLedgerRef, FREE_CASTS_PER_DAY, PLAN_CASTS, COST_EXTRA_CAST } =
  await import("../supabase/functions/_shared/services.ts");

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
/** 一個只有這個人的資料庫；lingshi 為其靈石餘額 */
const dbWith = (lingshi = 0, quota?: { used_today: number; last_reset: string }) => fakeDb({
  profiles: [{ id: U, lingshi }],
  free_quota: quota ? [{ key: U, ...quota }] : [],
});

console.log("\n起卦計費與標價\n");

await t("免費額度內：不扣靈石，freeLeft 逐卦遞減", async () => {
  const db = dbWith(100);
  const free = PLAN_CASTS.free;
  for (let i = 0; i < free; i++) {
    const r = await billCast(db, U, U, "free");
    ok(r.ok, `第 ${i + 1} 卦應該過`);
    eq(r.paid, 0, `第 ${i + 1} 卦不該扣靈石`);
    eq(r.freeLeft, free - i - 1, `第 ${i + 1} 卦之後的剩餘卦數`);
  }
  eq(db._store.profiles[0].lingshi, 100, "免費額度內，餘額不該動");
});

await t("額度用盡：扣 COST_EXTRA_CAST，freeLeft 歸零", async () => {
  const db = dbWith(100);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  const r = await billCast(db, U, U, "free");
  ok(r.ok, "有靈石就該讓他加卦");
  eq(r.paid, COST_EXTRA_CAST, "加卦應扣的靈石");
  eq(r.freeLeft, 0, "額度已盡");
  eq(db._store.profiles[0].lingshi, 100 - COST_EXTRA_CAST, "餘額應少掉一卦的錢");
});

await t("額度盡、靈石也不夠：擋下來，且餘額原封不動", async () => {
  const db = dbWith(COST_EXTRA_CAST - 1);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  const r = await billCast(db, U, U, "free");
  ok(!r.ok, "扣不動就該擋");
  eq(r.reason, "lingshi", "擋的理由");
  eq(r.paid, 0, "擋下來不該扣到錢");
  eq(db._store.profiles[0].lingshi, COST_EXTRA_CAST - 1, "擋下來餘額必須原封不動");
});

await t("擋下來時回得出「需幾顆／你有幾顆」——付費牆才講得出數字", async () => {
  const db = dbWith(3);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  const r = await billCast(db, U, U, "free");
  eq(r.need, COST_EXTRA_CAST, "需要幾顆");
  eq(r.lingshi, 3, "他手上有幾顆");
});

await t("付費方案吃 PLAN_CASTS，不是免費層那個數字", async () => {
  const db = dbWith(0);   // 刻意零靈石：撐得住第 N 卦就證明吃的是方案額度
  const quota = PLAN_CASTS.zhiji;
  ok(quota > FREE_CASTS_PER_DAY, "測試前提：付費方案的額度要比免費層多");
  for (let i = 0; i < quota; i++) {
    const r = await billCast(db, U, U, "zhiji");
    ok(r.ok && r.paid === 0, `付費方案第 ${i + 1} 卦仍應免費`);
  }
  const r = await billCast(db, U, U, "zhiji");
  ok(!r.ok, "超過方案額度、又沒靈石，才該擋");
});

await t("標價與計費讀同一把額度：castFreeLeft 等於下一卦是不是免費", async () => {
  const db = dbWith(100);
  for (let i = 0; i <= PLAN_CASTS.free; i++) {
    const left = await castFreeLeft(db, U, "free");
    const r = await billCast(db, U, U, "free");
    // 標價說還有免費卦，這一卦就必須真的沒扣錢；說沒有了，就必須真的扣了錢
    eq(r.paid === 0, left > 0, `第 ${i + 1} 卦：標價(${left}) 與實扣(${r.paid}) 對不上`);
  }
});

await t("隔日歸零：last_reset 不是今天，等於今日一卦未用", async () => {
  const db = dbWith(0, { used_today: 99, last_reset: "2000-01-01" });
  eq((await castFreeUsed(db, U)).used, 0, "昨天用了幾卦與今天無關");
  eq(await castFreeLeft(db, U, "free"), PLAN_CASTS.free, "今日額度應是滿的");
  const r = await billCast(db, U, U, "free");
  ok(r.ok && r.paid === 0, "隔日第一卦應免費（零靈石也該過）");
  eq(db._store.free_quota[0].used_today, 1, "舊的 99 應被今日的 1 蓋掉");
  eq(db._store.free_quota[0].last_reset, taipeiToday(), "last_reset 應蓋成今天");
});

await t("日界走台北，不是 UTC——否則台北 00:00–08:00 這八小時額度會對不上", async () => {
  // 台北時間的今天：直接以 UTC+8 推，與 taipeiToday() 各算各的，算出同一天才算對得上
  const expect = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  eq(taipeiToday(), expect, "taipeiToday 應為 UTC+8 的日期");
  // UTC 日界在台北 08:00 才換日：兩者不同的那八小時，就是舊寫法會出錯的區間
  const utcToday = new Date().toISOString().slice(0, 10);
  const taipeiHour = new Date(Date.now() + 8 * 3600_000).getUTCHours();
  eq(taipeiToday() === utcToday, taipeiHour >= 8, "台北 08:00 前後，兩套日界本就該不同");
});

await t("額度鍵不同就各記各的——TG 與網頁不共用同一份免費卦", async () => {
  const db = dbWith(0);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  eq(await castFreeLeft(db, U, "free"), 0, "網頁那把已用盡");
  eq(await castFreeLeft(db, `tg:123`, "free"), PLAN_CASTS.free, "TG 那把不受影響");
});

await t("加卦扣款事後接得回它買到的那支卦", async () => {
  const db = dbWith(100);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  const r = await billCast(db, U, U, "free");
  eq(r.paid, COST_EXTRA_CAST, "這一卦該是付費的");
  await linkLedgerRef(db, U, "extra_cast", "cast-1");
  const led = db._store.ledger.filter((x: any) => x.action === "extra_cast");
  eq(led.length, 1, "只該有一筆加卦流水");
  eq(led[0].ref_id, "cast-1", "那筆流水該指向剛起的卦");
});

await t("接的是最新那一筆，不會去改已經接好的舊帳", async () => {
  const db = dbWith(100);
  for (let i = 0; i < PLAN_CASTS.free; i++) await billCast(db, U, U, "free");
  await billCast(db, U, U, "free");
  await linkLedgerRef(db, U, "extra_cast", "cast-1");
  await billCast(db, U, U, "free");
  await linkLedgerRef(db, U, "extra_cast", "cast-2");
  const led = db._store.ledger.filter((x: any) => x.action === "extra_cast");
  eq(led.map((x: any) => x.ref_id).join(","), "cast-1,cast-2", "兩筆各自接各自的卦");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
