// dev/refusal-test.mts — 模型拒答與追問退費。
//
// 拒答是 HTTP 200、stop_reason "refusal"，正文可能是空的。它不丟錯的話，
// 呼叫端會把一張空卦紙當成成功存起來，錢也不退——而這種 bug 不會噴任何錯。
// 這裡驗兩件事：callInterpret 遇到拒答會丟錯（交給備援鏈與退費），
// 以及追問失敗時 refundFollowup 會把錢或額度、次數都退回。
//
// 跑法：node dev/refusal-test.mts

// env 可在測試中途改：KIMI_API_KEY 是呼叫當下才讀的（決定有沒有備援）
const ENV: Record<string, string | undefined> = {};
(globalThis as Record<string, unknown>).Deno ??= { env: { get: (k: string) => ENV[k] } };

let calls = 0;
let reply: Record<string, unknown> = {};
globalThis.fetch = (async () => {
  calls++;
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

import { fakeDb } from "./fake-db.mts";
const { callInterpret, billFollowup, refundFollowup, isRefusal, REFUSAL_MSG, PLAN_FOLLOWUPS, taipeiToday } =
  await import("../supabase/functions/_shared/services.ts");
const { COST } = await import("../supabase/functions/_shared/prices.ts");

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

console.log("\n模型拒答\n");

await t("stop_reason=refusal 會丟錯，不回一張空卦紙", async () => {
  reply = { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" },
    usage: { input_tokens: 10, output_tokens: 0 } };
  let threw: unknown = null;
  try { await callInterpret("persona", "chart", {}); } catch (e) { threw = e; }
  ok(threw, "應該丟錯");
  ok(/refusal/.test(String((threw as Error)?.message)), `錯誤訊息應帶 refusal：${threw}`);
});

await t("只寫了一半就拒答，也丟錯（不交付半張卦紙）", async () => {
  reply = { content: [{ type: "text", text: "此卦主" }], stop_reason: "refusal", stop_details: null,
    usage: { input_tokens: 10, output_tokens: 3 } };
  let threw = false;
  try { await callInterpret("persona", "chart", {}); } catch { threw = true; }
  ok(threw, "應該丟錯");
});

await t("拒答丟的是 RefusalError，帶類別", async () => {
  reply = { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "bio" } };
  let threw: unknown = null;
  try { await callInterpret("persona", "chart", {}); } catch (e) { threw = e; }
  ok(isRefusal(threw), "應能被 isRefusal 認出");
  eq((threw as { category: string }).category, "bio", "類別");
});

await t("設了 KIMI 備援，拒答也不轉送：只打一次模型", async () => {
  ENV.KIMI_API_KEY = "test";
  try {
    reply = { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } };
    const before = calls;
    let threw: unknown = null;
    try { await callInterpret("persona", "chart", {}); } catch (e) { threw = e; }
    ok(isRefusal(threw), "應丟拒答");
    eq(calls - before, 1, "fetch 次數（不該再打 KIMI）");
  } finally { delete ENV.KIMI_API_KEY; }
});

await t("技術失敗照舊走備援：設了 KIMI 就會再打一次", async () => {
  ENV.KIMI_API_KEY = "test";
  const saved = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) return new Response("overloaded", { status: 529 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "此卦吉。" }, finish_reason: "stop" }], usage: {} }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const r = await callInterpret("persona", "chart", { deepen: { briefReading: "" } });
    eq(n, 2, "fetch 次數（主模型＋KIMI）");
    ok(String(r.reading).includes("此卦吉"), `reading：${r.reading}`);
  } finally { globalThis.fetch = saved; delete ENV.KIMI_API_KEY; }
});

await t("拒答說明不提分類器類別、有說退費", () => {
  ok(!/harm|bio|cyber|類別/i.test(REFUSAL_MSG), "不該出現類別");
  ok(/退回/.test(REFUSAL_MSG), "要說退費");
});

await t("正常回覆照常回傳", async () => {
  reply = { content: [{ type: "text", text: "此卦吉。" }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 3 } };
  const r = await callInterpret("persona", "chart", { deepen: { briefReading: "" } });
  ok(String(r.reading).includes("此卦吉"), `reading：${r.reading}`);
});

console.log("\n追問失敗退費\n");

const U = "user-1";
const dbWith = (lingshi: number) => fakeDb({
  profiles: [{ id: U, lingshi }],
  casts: [{ id: "c1", user_id: U, followup_used: 0 }],
});

await t("免費額度內：退回一格，followup_used 減回", async () => {
  const db = dbWith(0);
  const bill = await billFollowup(db, U, "c1", "free");
  ok(bill.ok && bill.paid === 0, "第一次應免費");
  await refundFollowup(db, U, "c1", bill);
  const q = db._store.free_quota.find((r: any) => r.key === `followfree:${U}:${taipeiToday()}`);
  eq(q.used_today, 0, "免費額度應退回");
  eq(db._store.casts[0].followup_used, 0, "追問次數應減回");
});

await t("付費：退回靈石，流水記一筆追問退款", async () => {
  const db = dbWith(100);
  const free = PLAN_FOLLOWUPS.free;
  for (let i = 0; i < free; i++) await billFollowup(db, U, "c1", "free");
  const bill = await billFollowup(db, U, "c1", "free");
  eq(bill.paid, COST.followup, "這一次該付費");
  await refundFollowup(db, U, "c1", bill);
  eq(db._store.profiles[0].lingshi, 100, "餘額應回到原值");
  ok(db._store.ledger.some((r: any) => r.action === "followup_refund" && r.amount === COST.followup && r.ref_id === "c1"),
    "應有一筆 followup_refund");
});

await t("反問免費的那一次：不動錢與額度，只減次數", async () => {
  const db = dbWith(50);
  const bill = await billFollowup(db, U, "c1", "free", true);
  ok(bill.waived, "應為 waived");
  await refundFollowup(db, U, "c1", bill);
  eq(db._store.profiles[0].lingshi, 50, "餘額不動");
  eq((db._store.free_quota ?? []).length, 0, "不該碰免費額度");
  eq(db._store.casts[0].followup_used, 0, "次數減回");
});

console.log(`\n${pass} 過 / ${fail} 敗（fetch 被呼叫 ${calls} 次）\n`);
if (fail) process.exit(1);
