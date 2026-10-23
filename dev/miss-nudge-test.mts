// dev/miss-nudge-test.mts — 應期「沒準」提醒（_shared/miss-nudge.ts）。
// 驗：最近 5 次裡沒準（部分準算半）到 3 才跳；回評不滿 3 次不算；看過之後 30 天內不跳；
// 只看最近 5 次（舊的沒準不算）；跳的人是最常起卦的那位（同票取最近）。
// 跑法：node dev/miss-nudge-test.mts
import { fakeDb } from "./fake-db.mts";
import { missNudgeOf, markMissNudge, topCharOf } from "../supabase/functions/_shared/miss-nudge.ts";

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log("  ✅ " + name); } catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}`); };
// verdicts：由舊到新
const fb = (vs: number[]) => vs.map((v, i) => ({ cast_id: "c" + i, user_id: "u1", verdict: v, answered_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }));
const casts = (list: string[]) => list.map((c, i) => ({ id: "k" + i, user_id: "u1", character_id: c, created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }));
const db = (vs: number[], seen: string | null = null, cs: string[] = ["daoshi_f"]) =>
  fakeDb({ feedback: fb(vs), profiles: [{ id: "u1", miss_nudge_seen_at: seen }], casts: casts(cs) }) as any;

await t("連三次沒準：第三次就跳", async () => {
  eq(await missNudgeOf(db([3, 3]), "u1"), null);
  eq(await missNudgeOf(db([3, 3, 3]), "u1"), { cid: "daoshi_f", misses: 3, of: 3 });
});
await t("部分準算半次：沒準 2＋部分準 2＝3 會跳；沒準 2＋部分準 1 不跳", async () => {
  eq((await missNudgeOf(db([1, 3, 2, 3, 2]), "u1"))?.misses, 2);
  eq(await missNudgeOf(db([1, 1, 3, 2, 3]), "u1"), null);
});
await t("只看最近 5 次：很久以前的沒準不算", async () => {
  eq(await missNudgeOf(db([3, 3, 3, 1, 1, 1, 1, 1]), "u1"), null);
});
await t("偶爾一次沒準不跳", async () => {
  eq(await missNudgeOf(db([1, 1, 3, 1, 1]), "u1"), null);
});
await t("看過之後 30 天內不跳，過了再跳", async () => {
  const d = db([3, 3, 3]);
  eq((await markMissNudge(d, "u1")).ok, true);
  eq(await missNudgeOf(d, "u1"), null);
  eq((await missNudgeOf(d, "u1", Date.now() + 31 * 86400000))?.of, 3);
});
await t("最常起卦的那位；同票取最近", async () => {
  eq(await topCharOf(fakeDb({ casts: casts(["daoshi_m", "lingshou", "lingshou", "daoshi_f"]) }) as any, "u1"), "lingshou");
  eq(await topCharOf(fakeDb({ casts: casts(["daoshi_m", "daoshi_f"]) }) as any, "u1"), "daoshi_f");
  eq(await topCharOf(fakeDb({}) as any, "u1"), "daoshi_m");
});

console.log(`\n${pass} 過、${fail} 不過`);
if (fail) process.exit(1);
