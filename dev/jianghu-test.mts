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
t("拆旗 → 見群龍无首（六爻皆動）", () => { const w = keep(route([0,1,2,3,4,5], ["撕下","下河","陪你練","捕頭也","推回去","回客棧","你收了","回渡口叫","跳下水","讓擺船","收進懷裡","把龍旗搶過來","站到","哪兒也不去"])); if (title(w) !== "見群龍无首") throw new Error(title(w)); });
t("喊上去 → 亢龍有悔", () => { const w = keep(route([], ["找他","肋下","收下錦囊","回客棧","躍上","搖頭","上去"])); if (title(w) !== "亢龍有悔") throw new Error(title(w)); });
t("陪爬 → 龍柱之上（五爻動、紙條折成紙鶴）", () => { const w = keep(route([4], ["替婆婆","陪你練","卦我替","揣進懷裡","當眾","把帳本","折成紙鶴","陪他一起"])); if (title(w) !== "龍柱之上") throw new Error(title(w)); });
t("陪爬但沒折紙鶴 → 不是龍柱之上", () => { const w = route([4], ["替婆婆","陪你練","卦我替","揣進懷裡","當眾","把帳本","小心收進懷裡","陪他一起"]); if (title(w) === "龍柱之上") throw new Error("不該是龍柱之上"); });
t("揭帳本 → 飛龍在天", () => { const w = keep(route([], ["撕下","把渡錢告示","卦我替","揣進懷裡","當眾","把帳本","攔住"])); if (title(w) !== "飛龍在天") throw new Error(title(w)); });
t("上爻動、攔下、交給捕頭 → 潛龍在淵（稀有）", () => { const w = keep(route([5], ["撕下","肋下","推回去","回客棧","躍上","搖頭","攔住","看著","跟他去"])); if (title(w) !== "潛龍在淵") throw new Error(title(w)); });
t("上爻沒動：捕頭不出現、走不到潛龍在淵", () => { const w = route([], ["撕下","肋下","推回去","回客棧","躍上","搖頭","攔住"]); if (title(w) === "潛龍在淵") throw new Error("不該是潛龍在淵"); });
t("前路銜接：喊上去的那一趟，上爻變數只演「來晚了」、沒有跟捕頭走的選項", () => { let saw = false;
  const w = J.walk(doc, [5], (cs) => { if (cs.some((c) => (c.label ?? "").includes("跟他去"))) saw = true; const c = cs.find((x) => /上去|看著/.test(x.label ?? "")); return (c ?? cs[0]).key; });
  if (!w.ok) throw new Error(w.err); if (saw) throw new Error("喊上去之後不該再看到跟捕頭走"); if (w.ending.title !== "亢龍有悔") throw new Error(w.ending.title); });
t("前路銜接：客戶端劇本帶 after", () => { const c = J.clientDoc(doc).nodes[5].change as { after?: string[] }[]; if (!c.some((x) => (x.after ?? []).includes("c35"))) throw new Error("沒帶 after"); });
t("保底 → 空手而歸", () => { const w = keep(route([], ["找他","陪你練","收下","回客棧","躍上","搖頭","攔住"])); if (title(w) !== "空手而歸") throw new Error(title(w)); });
t("帳頁舉起來、沒揭局 → 斷尾（10-24 DeepSeek 校稿新增）", () => { const w = keep(route([0], ["撕下","下河","肋下","推回去","回客棧","站在台下","泡爛的帳頁","攔住"])); if (title(w) !== "斷尾") throw new Error(title(w)); });
t("四爻說破周收錢：帶帳本或周的口風任一樣就看得到，都沒有就看不到", () => {
  const seen = (moving: number[], want: string[]) => { let saw = false; const ch = by(want);
    const w = J.walk(doc, moving, (cs) => { if (cs.some((c) => (c.label ?? "").includes("周收了萬金號"))) saw = true; return ch(cs); }); if (!w.ok) throw new Error(w.err); return saw; };
  if (!seen([2], ["找他","肋下","推回去","回客棧","你收了"])) throw new Error("帶著周的口風卻看不到");
  if (!seen([], ["找他","肋下","卦我替","揣進懷裡"])) throw new Error("帶著帳本卻看不到");
  if (seen([], ["找他","肋下","推回去","回客棧"])) throw new Error("兩樣都沒帶卻看得到");
});
t("六條路走完：見群龍无首、六位時成亮；時乘六龍亮（第一趟六爻皆動）", () => {
  const lit = J.litAchievements(doc, runs);
  for (const id of ["qun", "liuwei", "liulong"]) if (!lit.includes(id)) throw new Error(`沒亮 ${id}（亮了 ${lit}）`);
});
t("品物流形：初、二、三、五爻動，一趟帶齊八樣", () => {
  const w = route([0, 1, 2, 4], ["撕下","下河","陪你練","捕頭也","收下錦囊","繞到","揣進懷裡","你收了","回渡口叫","讓擺船","小心收進懷裡","把龍旗拆了"]);
  if (!w.ok) throw new Error("走不完");
  if (J.allItems(doc).length !== 8) throw new Error("道具不是八樣：" + J.allItems(doc));
  if (!J.litAchievements(doc, [{ ending_id: w.ending.id, changes: w.changes, items: w.items }]).includes("pinwu")) throw new Error("沒亮，帶著 " + w.items);
});
t("品物流形：初爻沒動就湊不齊", () => {
  const w = route([1], ["撕下","陪你練","捕頭也","收下錦囊","繞到","揣進懷裡","回渡口叫","讓擺船"]);
  if (w.ok && J.litAchievements(doc, [{ ending_id: w.ending.id, changes: w.changes, items: w.items }]).includes("pinwu")) throw new Error("不該亮");
});
// 成就「一趟之內做到」（kind:"run"）：道具＋數值（＋結局）要在同一趟
t("一趟之內：帶著師兄的小抄、義 ≥ 3 才亮；數值不夠、道具不在、舊紀錄沒 st 都不亮", () => {
  const d2 = { ...doc, achievements: [{ id: "x", name: "測", kind: "run", items: ["師兄的小抄"], need: { s1: [3, null] } }] };
  const ok = { ending_id: "a", changes: [], items: ["師兄的小抄"], st: { s1: 3 } };
  if (!J.litAchievements(d2, [ok]).includes("x")) throw new Error("該亮");
  if (J.litAchievements(d2, [{ ...ok, st: { s1: 2 } }]).includes("x")) throw new Error("義不夠也亮");
  if (J.litAchievements(d2, [{ ...ok, items: [] }]).includes("x")) throw new Error("沒帶小抄也亮");
  if (J.litAchievements(d2, [{ ...ok, st: null }]).includes("x")) throw new Error("沒 st 也亮");
  // 兩個條件分在兩趟：不算
  if (J.litAchievements(d2, [{ ...ok, st: { s1: 0 } }, { ...ok, items: [], st: { s1: 9 } }]).includes("x")) throw new Error("分兩趟也亮");
});
t("一趟之內：綁結局時也要是那個結局；什麼都沒填不亮", () => {
  const d2 = { ...doc, achievements: [{ id: "y", name: "測", kind: "run", ending: "e05w0w", need: { s2: [5, null] } }, { id: "z", name: "空", kind: "run" }] };
  const r = { ending_id: "e05w0w", changes: [], items: [], st: { s2: 5 } };
  const lit = J.litAchievements(d2, [r]);
  if (!lit.includes("y")) throw new Error("該亮"); if (lit.includes("z")) throw new Error("空條件亮了");
  if (J.litAchievements(d2, [{ ...r, ending_id: "ea88v3" }]).includes("y")) throw new Error("結局不對也亮");
});
t("一趟之內：實際走一趟——潛龍在淵且智 ≥ 3", () => {
  const w = route([5], ["撕下","肋下","不敢起","推回去","繞到","只記下","站在台下","搖頭","攔住","看著","跟他去"]);
  if (!w.ok) throw new Error("走不完");
  const d2 = { ...doc, achievements: [{ id: "q", name: "測", kind: "run", ending: "e05w0w", need: { s2: [3, null] } }] };
  if (!J.litAchievements(d2, [{ ending_id: w.ending.id, changes: w.changes, items: w.items, st: w.st }]).includes("q")) throw new Error("沒亮，智 " + w.st.s2);
});
t("財：起始 3 兩；付了渡錢剩 2，撈槍（要 3）選不到", () => {
  let saw = false;
  const w = J.walk(doc, [], (cs) => { if (cs.some((c) => (c.label ?? "").includes("撈槍"))) saw = true;
    const pref = ["替婆婆", "推回去", "回客棧"]; for (const k of pref) { const c = cs.find((x) => (x.label ?? "").includes(k)); if (c) return c.key; } return cs[0].key; });
  if (!w.ok) throw new Error(w.err); if (saw) throw new Error("錢不夠卻出現在可選裡"); if (w.st.s5 !== 2) throw new Error("財應為 2，得到 " + w.st.s5);
});
t("財：收了錦囊（+5）就撈得起槍，撈完扣 3", () => {
  let took = false;
  const w = J.walk(doc, [], (cs) => { const c = cs.find((x) => (x.label ?? "").includes("撈槍")); if (c) { took = true; return c.key; }
    const pref = ["替婆婆", "收下錦囊", "回客棧"]; for (const k of pref) { const x = cs.find((y) => (y.label ?? "").includes(k)); if (x) return x.key; } return cs[0].key; });
  if (!w.ok) throw new Error(w.err); if (!took) throw new Error("沒出現撈槍"); if (w.st.s5 !== 3 - 1 + 5 - 3) throw new Error("財應為 4，得到 " + w.st.s5);
});
t("選項 key 全篇不重複", () => { const ks = doc.nodes.flatMap((n: any) => [...n.scenes, ...(n.change?.scenes ?? [])]).flatMap((x: any) => (x.choices ?? []).map((c: any) => c.key));
  const dup = ks.filter((k: string, i: number) => ks.indexOf(k) !== i); if (dup.length) throw new Error("重複：" + dup.join(",")); });
t("亂送 key、多送、少送都拒絕", () => {
  if (J.walk(doc, [], ["nope"]).ok) throw new Error("亂送過了");
  const w = route([], ["找他"]); if (!w.ok) throw new Error();
  const keys: string[] = []; J.walk(doc, [], (cs) => { keys.push(cs[0].key); return cs[0].key; });
  if (J.walk(doc, [], [...keys, keys[0]]).ok) throw new Error("多送過了");
  if (J.walk(doc, [], keys.slice(0, -1)).ok) throw new Error("少送過了");
});
t("下發的劇本不帶結局與成就條件", () => {
  const s = JSON.stringify(J.clientDoc(doc));
  for (const k of ["endings", "insight", "npc_fate", "achievements", "\"set\"", "outline"]) if (s.includes(k)) throw new Error("帶了 " + k);
});
t("化名：字庫組得出來的才收（入口自己骰的）", () => {
  for (let i = 0; i < 200; i++) { const n = J.alias("seed" + i); if (!J.aliasOk(n)) throw new Error("自己產的不認：" + n); }
  for (const bad of ["", "王小明", "沈", "沈青崖崖", "<b>", "司馬"]) if (J.aliasOk(bad)) throw new Error("不該收：" + bad);
  if (!J.aliasOk("司馬崖") || !J.aliasOk("沈青崖")) throw new Error("該收");
});
t("化名同一個種子固定", () => { if (J.alias("2026-10-21|1|u") !== J.alias("2026-10-21|1|u")) throw new Error(); });
t("動爻：6、9 是動爻", () => { if (JSON.stringify(J.movingOf([7, 9, 8, 6, 7, 7])) !== "[1,3]") throw new Error(); });
console.log(`\n${pass} 過、${fail} 錯\n`); if (fail) process.exit(1);
