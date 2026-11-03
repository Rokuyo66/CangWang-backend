// dev/jianwen-test.mts — 見聞（_shared/jianwen.ts）：照走過的趟數算去過的場景、見過的人、下場、完整度。
// 跑法：node dev/jianwen-test.mts
import { readFileSync } from "node:fs";
const J = await import("../supabase/functions/_shared/jianghu.ts");
const { jwBoard } = await import("../supabase/functions/_shared/jianwen.ts");
const doc = JSON.parse(readFileSync("dev/design/journal/jianghu/gua_01.json", "utf8"));
const world = JSON.parse(readFileSync("dev/design/journal/jianwen.json", "utf8"));
let pass = 0, fail = 0;
const t = async (n: string, f: () => Promise<void>) => { try { await f(); pass++; console.log("  ✅ " + n); } catch (e) { fail++; console.log("  ❌ " + n + "\n     " + (e as Error).message); } };
const by = (want: string[]) => { const q = [...want]; return (cs: { key: string; label?: string }[]) => {
  for (let a = 0; a < q.length; a++) { const c = cs.find((x) => (x.label ?? "").includes(q[a])); if (c) { q.splice(a, 1); return c.key; } } return cs[0].key; }; };
const run = (moving: number[], want: string[]) => { const keys: string[] = []; const ch = by(want); const w = J.walk(doc, moving, (cs) => { const k = ch(cs); keys.push(k); return k; }); if (!w.ok) throw new Error(w.err); return { gua_no: 1, ending_id: w.ending.id, moving, picks: keys }; };
const q = (rows: any[]) => { const o: any = { select: () => o, eq: () => o, not: () => o, order: () => o, maybeSingle: async () => ({ data: rows[0] ?? null }), then: (r: any) => r({ data: rows }) }; return o; };
const db = (runs: any[]) => ({ from: (t: string) => q(t === "jianghu_config" ? [{ world }] : t === "jianghu_events" ? [{ gua_no: 1, gua: "乾為天", title: "龍不歸淵", doc }] : runs) }) as any;
console.log("\n見聞\n");
await t("沒走過：雲渡鎮的場景全暗、人物全是剪影", async () => {
  const b = await jwBoard(db([]), "u");
  const p = b.places[0]; if (p.name !== "雲渡鎮" || p.scenes.some((s: any) => s.seen)) throw new Error("應該全暗");
  if (Object.values(b.people).some((x: any) => x.seen)) throw new Error("人物應該都沒見過");
  if (!p.ppl.includes("n_shen")) throw new Error("沈捕頭應該列在雲渡鎮（剪影）");
});
await t("上爻動、交給捕頭：去過雲渡口等地、見過沈捕頭，下場亮一條", async () => {
  const b: any = await jwBoard(db([run([5], ["撕下","肋下","推回去","回客棧","躍上","搖頭","攔住","看著","跟他去"])]), "u");
  const seen = b.places[0].scenes.filter((s: any) => s.seen).map((s: any) => s.key);
  if (!seen.includes("dukou") || !seen.includes("longzhu")) throw new Error("場景：" + seen.join(","));
  const sh = b.people.n_shen; if (!sh.seen) throw new Error("沈捕頭沒亮");
  if (sh.got !== 1 || sh.of !== 1) throw new Error(`完整度 ${sh.got}/${sh.of}`);
  const lx = b.people.n_lingxiao; if (!lx.fates.some((f: any) => f.seen && f.text.includes("隨沈捕頭"))) throw new Error("凌霄的下場沒亮：" + JSON.stringify(lx.fates));
  if (!lx.fates.some((f: any) => !f.seen)) throw new Error("沒走到的下場應該是？？？");
});
await t("沒見過的人不帶名字（剪影只給 id）", async () => {
  const b: any = await jwBoard(db([]), "u");
  if (JSON.stringify(b.people).includes("沈捕頭")) throw new Error("洩漏名字");
});
console.log(`\n${pass} 過、${fail} 錯`);
if (fail) process.exit(1);
