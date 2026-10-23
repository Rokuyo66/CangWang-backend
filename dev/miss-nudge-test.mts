// dev/miss-nudge-test.mts — 應期「沒準」累積提醒（_shared/miss-nudge.ts）。
// 驗：5 次不跳、第 6 次跳；看過之後要再多 5 次才跳；跳的人是最常起卦的那位（同票取最近）。
// 跑法：node dev/miss-nudge-test.mts
import { fakeDb } from "./fake-db.mts";
import { missNudgeOf, markMissNudge, topCharOf } from "../supabase/functions/_shared/miss-nudge.ts";

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log("  ✅ " + name); } catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`); };
const misses = (n: number) => Array.from({ length: n }, (_, i) => ({ cast_id: "c" + i, user_id: "u1", verdict: 3 }));
const casts = (list: string[]) => list.map((c, i) => ({ id: "k" + i, user_id: "u1", character_id: c, created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }));

await t("沒準 5 次不跳、第 6 次跳", async () => {
  eq(await missNudgeOf(fakeDb({ feedback: misses(5), profiles: [{ id: "u1", miss_nudge_at: null }] }) as any, "u1"), null);
  eq(await missNudgeOf(fakeDb({ feedback: misses(6), profiles: [{ id: "u1", miss_nudge_at: null }], casts: casts(["daoshi_f"]) }) as any, "u1"), { cid: "daoshi_f", misses: 6 });
});
await t("部分準、準不算", async () => {
  const fb = [...misses(5), { cast_id: "x", user_id: "u1", verdict: 2 }, { cast_id: "y", user_id: "u1", verdict: 1 }];
  eq(await missNudgeOf(fakeDb({ feedback: fb, profiles: [{ id: "u1" }] }) as any, "u1"), null);
});
await t("看過之後再多 5 次才再跳", async () => {
  const db = fakeDb({ feedback: misses(6), profiles: [{ id: "u1", miss_nudge_at: null }] }) as any;
  eq((await markMissNudge(db, "u1")).ok, true);
  eq(await missNudgeOf(db, "u1"), null);
  // 加到 10：還不跳；11：跳
  for (let i = 6; i < 10; i++) await db.from("feedback").insert({ cast_id: "c" + i, user_id: "u1", verdict: 3 });
  eq(await missNudgeOf(db, "u1"), null);
  await db.from("feedback").insert({ cast_id: "c10", user_id: "u1", verdict: 3 });
  eq((await missNudgeOf(db, "u1"))?.misses, 11);
});
await t("最常起卦的那位；同票取最近", async () => {
  eq(await topCharOf(fakeDb({ casts: casts(["daoshi_m", "lingshou", "lingshou", "daoshi_f"]) }) as any, "u1"), "lingshou");
  eq(await topCharOf(fakeDb({ casts: casts(["daoshi_m", "daoshi_f"]) }) as any, "u1"), "daoshi_f");
  eq(await topCharOf(fakeDb({}) as any, "u1"), "daoshi_m");
});

console.log(`\n${pass} 過、${fail} 不過`);
if (fail) process.exit(1);
