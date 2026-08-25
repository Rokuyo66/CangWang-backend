// dev/tts-quota-test.mts — 朗讀額度的規則測試。
//
// 這是整條線上唯一擋住 TTS 帳單的那道門，所以驗的是承諾而不是實作：
// 額度依玉牒分階、以「月」為單位、下個月一號重來、日上限只是煞車、
// 命中快取不吃額度（那一條在 speakCast 裡，這裡驗它依賴的算術）、
// 台北日界不是 UTC 日界（以前是，等於每日額度在早上八點才重置）。
//
// tts.ts 載入時就讀 Deno.env，所以先擺一個替身再動態載入——
// 這一支要能在 node 上跑，跟其他六支一樣。
//
// 跑法：node dev/tts-quota-test.mts

import { fakeDb } from "./fake-db.mts";

(globalThis as any).Deno = { env: { get: () => undefined } };

const {
  PLAN_TTS_CHARS, ttsQuotaOf, dailyCapOf, taipeiToday, monthRange, ttsQuota, spendQuota,
} = await import("../supabase/functions/_shared/tts.ts");

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
/** 直接寫一列日用量，當作「他那天念了這麼多」 */
const used = (db: any, day: string, chars: number) =>
  db.from("tts_usage").insert({ user_id: U, day, chars });

console.log("\n朗讀額度\n");

await t("四階各有各的額度，不是全站一個數字", async () => {
  eq(ttsQuotaOf("free"), 2000, "無牒");
  eq(ttsQuotaOf("guanwei"), 12000, "觀微");
  eq(ttsQuotaOf("zhiji"), 30000, "知幾");
  eq(ttsQuotaOf("cangwang"), 60000, "藏往");
  ok(ttsQuotaOf("free") < ttsQuotaOf("cangwang"), "分階分假的");
  eq(ttsQuotaOf("沒這一階"), PLAN_TTS_CHARS.free, "不認得的方案該當作無牒");
});

await t("日上限只是煞車：正常人碰不到，跑掉的迴圈燒不完整個月", async () => {
  eq(dailyCapOf(60000), 15000, "藏往的日煞車該是月額度的四分之一");
  eq(dailyCapOf(2000), 3000, "無牒的月額度比下限還小，日煞車不該反而擋住他");
  ok(dailyCapOf(ttsQuotaOf("free")) >= ttsQuotaOf("free"),
    "免費的日煞車若小於月額度，等於他永遠用不完自己的月額度");
});

await t("日界是台北不是 UTC——以前的寫法等於早上八點才重置", async () => {
  // 台北 2026-03-10 00:30 ＝ UTC 2026-03-09 16:30
  eq(taipeiToday(new Date("2026-03-09T16:30:00Z")), "2026-03-10", "跨日沒跟上");
  eq(taipeiToday(new Date("2026-03-09T15:30:00Z")), "2026-03-09", "早跳了一天");
});

await t("月的範圍框得對，十二月要跨年", async () => {
  const a = monthRange("2026-03-10");
  eq(a.from, "2026-03-01", "月初"); eq(a.to, "2026-04-01", "下月初");
  const b = monthRange("2026-12-31");
  eq(b.from, "2026-12-01", "十二月初"); eq(b.to, "2027-01-01", "跨年沒跨過去");
});

await t("月用量是當月每一天加起來，上個月的不算", async () => {
  const db = fakeDb() as any;
  const day = taipeiToday();
  const { from } = monthRange(day);
  await used(db, from, 500);                       // 這個月月初
  await used(db, day, 300);                        // 今天
  await used(db, "2000-01-05", 99999);             // 老早以前

  const q = await ttsQuota(db, U, "free");
  eq(q.used, 800, "上個月的被算進來了，或當月的漏了");
  eq(q.max, 2000, "無牒 2000");
  eq(q.left, 1200, "剩餘算錯");
  eq(q.day_used, 300, "今天用了多少算錯");
});

await t("月額度用完就擋，而且說得出「下個月重來」", async () => {
  const db = fakeDb() as any;
  await used(db, taipeiToday(), 1900);
  const r = await spendQuota(db, U, "free", 200);   // 1900 + 200 > 2000
  eq(r.ok, false, "超額卻放行");
  ok(!r.ok && r.msg.includes("持玉牒"), "無牒超額該指路，得到：" + (!r.ok ? r.msg : ""));
});

await t("無牒與藏往念同一段：一個擋下、一個放行", async () => {
  const db = fakeDb() as any;
  await used(db, taipeiToday(), 1900);
  eq((await spendQuota(db, U, "free", 700)).ok, false, "無牒該擋");
  eq((await spendQuota(db, U, "cangwang", 700)).ok, true, "藏往不該被無牒的額度擋住");
});

await t("放行會把用量記進去，記的是台北的那一天", async () => {
  const db = fakeDb() as any;
  eq((await spendQuota(db, U, "zhiji", 700)).ok, true, "額度夠卻擋了");
  const { data } = await db.from("tts_usage").select("day, chars").eq("user_id", U);
  eq(data.length, 1, "該只有一列");
  eq(data[0].day, taipeiToday(), "記到別天去了");
  eq(data[0].chars, 700, "記錯字數");

  // 同一天再念一次要累加，不是覆蓋
  await spendQuota(db, U, "zhiji", 300);
  const { data: after } = await db.from("tts_usage").select("chars").eq("user_id", U);
  eq(after.length, 1, "同一天不該長出第二列");
  eq(after[0].chars, 1000, "沒累加，被覆蓋掉了");
});

await t("月額度還在、但今天念太多：擋今天，並講明月額度還在", async () => {
  const db = fakeDb() as any;
  const cap = dailyCapOf(ttsQuotaOf("cangwang"));   // 15000
  await used(db, taipeiToday(), cap - 100);
  const r = await spendQuota(db, U, "cangwang", 500);
  eq(r.ok, false, "日煞車沒作用");
  ok(!r.ok && r.msg.includes("這個月的額度還在"), "話該說清楚，得到：" + (!r.ok ? r.msg : ""));
});

await t("剩餘量不會是負的——超額狀態顯示成 0，不是 -1200", async () => {
  const db = fakeDb() as any;
  await used(db, taipeiToday(), 5000);              // 無牒只有 2000
  const q = await ttsQuota(db, U, "free");
  eq(q.left, 0, "畫面上不該出現負的剩餘");
  eq(q.used, 5000, "used 仍該照實回報");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
