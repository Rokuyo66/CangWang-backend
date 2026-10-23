// dev/achievements-test.mts — 成就榜問事、道緣（_shared/achievements.ts，0106）。
// 驗：次數到了才亮、領過變 claimed、師兄事件完成任一則就亮、別人的事件不算、進度帶 have/need、領取的守門。
// 跑法：node dev/achievements-test.mts
import { achBoard, achClaim, ACH } from "../supabase/functions/_shared/achievements.ts";

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log("  ✅ " + name); } catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`); };

// 只做 achBoard 用到的那幾個：select / eq / not，thenable 回 {data,error}
function stub(tables: Record<string, any[]>, rpcLog: any[] = []) {
  const q = (rows: any[]) => {
    const o: any = { rows, select: () => o, eq: (k: string, v: unknown) => q(rows.filter((r) => r[k] === v)),
      not: (k: string) => q(rows.filter((r) => r[k] != null)),
      then: (res: any) => res({ data: rows, error: null }) };
    return o;
  };
  return { from: (t: string) => q(tables[t] ?? []),
    rpc: async (fn: string, args: any) => { rpcLog.push([fn, args]); return { data: { ok: true, balance: 99 }, error: null }; } } as any;
}
const st = (rows: any[], id: string) => rows.find((r) => r.id === id)?.state;

await t("沒做過：全部暗著", async () => {
  const b = (await achBoard(stub({}), "u1"))!;
  eq(b.length, ACH.length); eq(b.every((r) => r.state === "locked"), true);
});
await t("問過 6 卦：初筮、履霜亮，十朋之龜暗、進度 6／10", async () => {
  const b = (await achBoard(stub({ ach_progress: [{ user_id: "u1", key: "cast", n: 6 }] }), "u1"))!;
  eq([st(b, "ask_1"), st(b, "ask_5"), st(b, "ask_10")], ["lit", "lit", "locked"]);
  const r = b.find((x) => x.id === "ask_10")!; eq([r.have, r.need], [6, 10]);
});
await t("領過的變 claimed；別人的進度不算", async () => {
  const b = (await achBoard(stub({ ach_progress: [{ user_id: "u1", key: "cast", n: 1 }, { user_id: "u2", key: "method:num", n: 3 }],
    ach_claims: [{ user_id: "u1", ach_id: "ask_1" }] }), "u1"))!;
  eq([st(b, "ask_1"), st(b, "method_num")], ["claimed", "locked"]);
});
await t("師兄事件完成任一則就亮；師妹的不算、沒完成的不算", async () => {
  const ev = (cid: string, done: boolean) => ({ user_id: "u1", event_id: cid + "_e", completed_at: done ? "2026-10-23" : null, character_events: { character_id: cid } });
  eq(st((await achBoard(stub({ user_character_events: [ev("daoshi_f", true), ev("daoshi_m", false)] }), "u1"))!, "dy_daoshi_m"), "locked");
  eq(st((await achBoard(stub({ user_character_events: [ev("daoshi_m", true)] }), "u1"))!, "dy_daoshi_m"), "lit");
});
await t("領取：沒亮不給、亮了照表上的數發、領過不再給", async () => {
  eq((await achClaim(stub({}), "u1", "ask_1")).ok, false);
  const log: any[] = [];
  const r = await achClaim(stub({ ach_progress: [{ user_id: "u1", key: "via:agenda", n: 1 }] }, log), "u1", "via_agenda");
  eq(r, { ok: true, amount: 10, balance: 99 }); eq(log[0], ["ach_claim", { p_user: "u1", p_ach: "via_agenda", p_amount: 10 }]);
  eq((await achClaim(stub({ ach_progress: [{ user_id: "u1", key: "cast", n: 1 }], ach_claims: [{ user_id: "u1", ach_id: "ask_1" }] }), "u1", "ask_1")).ok, false);
  eq((await achClaim(stub({}), "u1", "nope")).ok, false);
});
await t("id 不重複", async () => { eq(new Set(ACH.map((a) => a.id)).size, ACH.length); });

console.log(`\n${pass} 過、${fail} 掛`);
if (fail) process.exit(1);
