// dev/jianghu-test.mts — 江湖尋訪：伺服器的走法與稿紙的試走一致。
// 拿乾為天（dev/design/journal/jianghu/gua_01.json）走六條路線，每條都要落在預期的結局；
// 再驗成就、下發給客戶端的劇本不帶結局。跑法：node dev/jianghu-test.mts
import { readFileSync } from "node:fs";
const J = await import("../supabase/functions/_shared/jianghu.ts");
const doc = JSON.parse(readFileSync("dev/design/journal/jianghu/gua_01.json", "utf8"));
let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  ✅ " + name); } catch (e) { fail++; console.log("  ❌ " + name + "\n     " + (e as Error).message); } };
const by = (want: string[]) => { const q = [...want]; return (cs: { key: string; label?: string }[]) => {
  for (let a = 0; a < q.length; a++) { const c = cs.find((x) => (x.label ?? "").includes(q[a])); if (c) { q.splice(a, 1); return c.key; } }
  return cs[0].key; }; };
const route = (moving: number[], want: string[]) => {
  const keys: string[] = []; const ch = by(want);
  const w = J.walk(doc, moving, (cs) => { const k = ch(cs); keys.push(k); return k; });
  if (!w.ok) throw new Error(w.err);
  const again = J.walk(doc, moving, keys);   // 同一串 key 再走一次＝客戶端送來的樣子
  if (!again.ok || again.ending.id !== w.ending.id) throw new Error("同一串 key 重走結果不同");
  return w;
};
const title = (w: ReturnType<typeof route>) => w.ok ? w.ending.title : "";
console.log("\n江湖尋訪・乾為天\n");
const runs: { ending_id: string; changes: number[]; items: string[] }[] = [];
const keep = (w: ReturnType<typeof route>) => { if (w.ok) runs.push({ ending_id: w.ending.id, changes: w.changes, items: w.items }); return w; };
t("拆旗 → 見群龍无首（六爻皆動）", () => { const w = keep(route([0,1,2,3,4,5], ["撕下","下河","陪你練","捕頭也","推回去","回客棧","你收了","回渡口叫","跳下水","讓擺船","收進懷裡","把龍旗拆了","站到"])); if (title(w) !== "見群龍无首") throw new Error(title(w)); });
t("喊上去 → 亢龍有悔", () => { const w = keep(route([], ["找他","肋下","收下錦囊","回客棧","躍上","搖頭","上去"])); if (title(w) !== "亢龍有悔") throw new Error(title(w)); });
t("陪爬 → 龍柱之上", () => { const w = keep(route([], ["替婆婆","陪你練","卦我替","揣進懷裡","當眾","把帳本","陪他一起"])); if (title(w) !== "龍柱之上") throw new Error(title(w)); });
t("揭帳本 → 飛龍在天", () => { const w = keep(route([], ["撕下","把渡錢告示","卦我替","揣進懷裡","當眾","把帳本","攔住"])); if (title(w) !== "飛龍在天") throw new Error(title(w)); });
t("看清不出手 → 潛龍在淵", () => { const w = keep(route([], ["撕下","肋下","推回去","繞到","只記下","站在台下","搖頭","攔住"])); if (title(w) !== "潛龍在淵") throw new Error(title(w)); });
t("保底 → 空手而歸", () => { const w = keep(route([], ["找他","陪你練","收下","回客棧","躍上","搖頭","攔住"])); if (title(w) !== "空手而歸") throw new Error(title(w)); });
t("六條路走完：見群龍无首、六位時成亮；時乘六龍亮（第一趟六爻皆動）", () => {
  const lit = J.litAchievements(doc, runs);
  for (const id of ["qun", "liuwei", "liulong"]) if (!lit.includes(id)) throw new Error(`沒亮 ${id}（亮了 ${lit}）`);
});
t("品物流形：初、二爻動，一趟帶齊六樣", () => {
  const w = route([0, 1], ["撕下","下河","陪你練","捕頭也","收下錦囊","繞到","揣進懷裡","你收了","回渡口叫","讓擺船","把龍旗拆了"]);
  if (!w.ok) throw new Error("走不完");
  if (J.allItems(doc).length !== 6) throw new Error("道具不是六樣：" + J.allItems(doc));
  if (!J.litAchievements(doc, [{ ending_id: w.ending.id, changes: w.changes, items: w.items }]).includes("pinwu")) throw new Error("沒亮，帶著 " + w.items);
});
t("品物流形：初爻沒動就湊不齊", () => {
  const w = route([1], ["撕下","陪你練","捕頭也","收下錦囊","繞到","揣進懷裡","回渡口叫","讓擺船"]);
  if (w.ok && J.litAchievements(doc, [{ ending_id: w.ending.id, changes: w.changes, items: w.items }]).includes("pinwu")) throw new Error("不該亮");
});
t("亂送 key、多送、少送都拒絕", () => {
  if (J.walk(doc, [], ["nope"]).ok) throw new Error("亂送過了");
  const w = route([], ["找他"]); if (!w.ok) throw new Error();
  const keys: string[] = []; J.walk(doc, [], (cs) => { keys.push(cs[0].key); return cs[0].key; });
  if (J.walk(doc, [], [...keys, keys[0]]).ok) throw new Error("多送過了");
  if (J.walk(doc, [], keys.slice(0, -1)).ok) throw new Error("少送過了");
});
t("下發的劇本不帶結局與成就條件", () => {
  const s = JSON.stringify(J.clientDoc(doc));
  for (const k of ["endings", "insight", "npc_fate", "achievements", "\"fx\"", "\"set\"", "outline"]) if (s.includes(k)) throw new Error("帶了 " + k);
});
t("化名同一個種子固定", () => { if (J.alias("2026-10-21|1|u") !== J.alias("2026-10-21|1|u")) throw new Error(); });
t("動爻：6、9 是動爻", () => { if (JSON.stringify(J.movingOf([7, 9, 8, 6, 7, 7])) !== "[1,3]") throw new Error(); });
console.log(`\n${pass} 過、${fail} 錯\n`); if (fail) process.exit(1);
