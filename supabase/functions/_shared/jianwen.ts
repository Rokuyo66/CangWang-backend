// _shared/jianwen.ts — 道籍 › 見聞（六六 2026-10-24）：江湖走過的地方、遇過的人。
//
// 以地點為主：地點名先公開，底下的場景去過才亮、人物見過才亮，沒有的前端畫「？？？」／剪影。
// 同一個人（同 npc id）在哪個地點出場都連到同一頁；三位主角不收（只收劇本 npcs 裡的人）。
//
// 地點、場景、人物的名字與說明＝jianghu_config.world（企劃工作臺「見聞設定」寫的，0109 起）。
// 去過哪、見過誰＝把玩家走完的每一趟照劇本重演一次（walk 的 trace），記下演到的場景與當時說話的人。
// 不另存一張「解鎖表」：劇本改了、見聞跟著改；紀錄就是 jianghu_runs。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { walk, type Doc, type Scene } from "./jianghu.ts";

export type World = {
  places?: { id: string; name: string; desc?: string }[];
  /** 場景 key（scene/<key>）→ 名字、屬於哪個地點、說明、橫幅框（x,y,w：佔圖寬高的比例，左上角與寬） */
  scenes?: Record<string, { name?: string; place?: string; desc?: string; banner?: { x: number; y: number; w: number } }>;
  /** 人物 id → 見聞說明、身分（沒寫就用劇本 npcs 的 desc） */
  people?: Record<string, { role?: string; desc?: string }>;
};
type Ev = { gua_no: number; gua: string; title: string; doc: Doc };
type Run = { gua_no: number; ending_id: string | null; moving: number[] | null; picks: string[] | null };

/** 一份劇本裡：每一幕演到時的場景（bg 會延續到下一次換場）與說話的本篇人物 */
function seen(doc: Doc, moving: number[], picks: string[]) {
  let bg = doc.opening?.bg ?? "";
  const bgs = new Set<string>(), meet: [string, string][] = [];   // [npc, 在哪個場景]
  if (bg) bgs.add(bg);
  const w = walk(doc, moving, picks, (s: Scene) => {
    if (typeof s.bg === "string" && s.bg) { bg = s.bg; bgs.add(bg); }
    if (typeof s.npc === "string" && s.npc) meet.push([s.npc, bg]);
  });
  return w.ok ? { bgs, meet, ending: w.ending } : null;
}
/** 劇本裡（不分路線）每位人物出現過的場景：決定他在哪些地點的人物格裡、出沒場景有哪些 */
function castOf(doc: Doc) {
  const at = new Map<string, Set<string>>();
  let bg = doc.opening?.bg ?? "";
  for (const n of doc.nodes) for (const s of [...(n.scenes ?? []), ...(n.change?.scenes ?? [])]) {
    if (typeof s.bg === "string" && s.bg) bg = s.bg;
    if (typeof s.npc === "string" && s.npc) { if (!at.has(s.npc)) at.set(s.npc, new Set()); at.get(s.npc)!.add(bg); }
  }
  return at;
}
const fateFor = (fate: string, name: string) => fate.split(/[；;]/).map((x) => x.trim()).filter((x) => x && x.includes(name));

export async function jwBoard(db: SupabaseClient, uid: string) {
  const [{ data: cfg }, { data: evs }, { data: runs }] = await Promise.all([
    db.from("jianghu_config").select("world").eq("id", "main").maybeSingle(),
    db.from("jianghu_events").select("gua_no, gua, title, doc").eq("published", true).order("gua_no"),
    db.from("jianghu_runs").select("gua_no, ending_id, moving, picks").eq("user_id", uid).not("finished_at", "is", null),
  ]);
  const world: World = (cfg as { world?: World } | null)?.world ?? {};
  const places = world.places ?? [], sceneCfg = world.scenes ?? {}, peopleCfg = world.people ?? {};
  const events = (evs ?? []) as Ev[];
  const evTitle = (e: Ev) => `${e.gua}「${e.title}」`;

  // 劇本面（不看玩家）：人物資料、出沒場景、出場的卦、每卦的人物下場有幾種
  const npc = new Map<string, { name: string; desc: string; at: Set<string>; evs: Set<number>; fates: Map<string, string> }>();
  const sceneEvs = new Map<string, Set<number>>();
  for (const e of events) {
    for (const n of e.doc.npcs ?? []) if (!npc.has(n.id)) npc.set(n.id, { name: n.name, desc: n.desc ?? "", at: new Set(), evs: new Set(), fates: new Map() });
    for (const [id, bgs] of castOf(e.doc)) {
      const o = npc.get(id); if (!o) continue;
      o.evs.add(e.gua_no); bgs.forEach((b) => o.at.add(b));
      for (const en of e.doc.endings) for (const f of fateFor(en.npc_fate ?? "", o.name)) o.fates.set(`${e.gua_no}:${en.id}:${f}`, f);
    }
    let bg = e.doc.opening?.bg ?? "";
    for (const n of e.doc.nodes) for (const s of [...(n.scenes ?? []), ...(n.change?.scenes ?? [])]) {
      if (typeof s.bg === "string" && s.bg) bg = s.bg;
      if (bg) { if (!sceneEvs.has(bg)) sceneEvs.set(bg, new Set()); sceneEvs.get(bg)!.add(e.gua_no); }
    }
  }
  // 玩家面：走過的每一趟重演
  const bgSeen = new Set<string>(), metAt = new Map<string, Set<string>>(), metEv = new Map<string, Set<number>>(), fateSeen = new Set<string>();
  const evSeen = new Set<number>();
  for (const r of (runs ?? []) as Run[]) {
    const e = events.find((x) => x.gua_no === r.gua_no); if (!e || !Array.isArray(r.picks)) continue;
    const w = seen(e.doc, r.moving ?? [], r.picks); if (!w) continue;
    evSeen.add(e.gua_no);
    w.bgs.forEach((b) => bgSeen.add(b));
    for (const [id, b] of w.meet) {
      if (!metAt.has(id)) metAt.set(id, new Set()); metAt.get(id)!.add(b);
      if (!metEv.has(id)) metEv.set(id, new Set()); metEv.get(id)!.add(e.gua_no);
    }
    for (const id of new Set(w.meet.map(([x]) => x))) for (const f of fateFor(w.ending.npc_fate ?? "", npc.get(id)?.name ?? "\u0000")) fateSeen.add(`${e.gua_no}:${w.ending.id}:${f}`);
  }
  const placeOfScene = (k: string) => sceneCfg[k]?.place ?? "";
  const evList = (ids: Set<number>, seenSet: Set<number>) => events.filter((e) => ids.has(e.gua_no)).map((e) => seenSet.has(e.gua_no) ? { title: evTitle(e), seen: true } : { title: "", seen: false });

  const out = places.map((p) => {
    const keys = Object.keys(sceneCfg).filter((k) => sceneCfg[k].place === p.id);
    const ppl = [...npc.entries()].filter(([, o]) => [...o.at].some((b) => placeOfScene(b) === p.id)).map(([id]) => id);
    return { id: p.id, name: p.name, desc: keys.some((k) => bgSeen.has(k)) ? (p.desc ?? "") : "",
      scenes: keys.map((k) => bgSeen.has(k)
        ? { key: k, seen: true, name: sceneCfg[k].name ?? k, desc: sceneCfg[k].desc ?? "", banner: sceneCfg[k].banner ?? null,
            ppl: [...metAt.entries()].filter(([, s]) => s.has(k)).map(([id]) => id), ev: evList(sceneEvs.get(k) ?? new Set(), evSeen) }
        : { key: k, seen: false }),
      ppl };
  });
  const people: Record<string, unknown> = {};
  for (const [id, o] of npc) {
    if (!out.some((p) => p.ppl.includes(id))) continue;   // 不在任何地點的人不列（例：只在觀裡出場）
    const met = metEv.has(id), c = peopleCfg[id] ?? {};
    const at = [...o.at].filter((b) => placeOfScene(b));
    people[id] = met ? {
      seen: true, name: o.name, role: c.role ?? "", desc: c.desc || o.desc,
      at: at.map((b) => bgSeen.has(b) ? { key: b, place: placeOfScene(b), name: sceneCfg[b]?.name ?? b, seen: true } : { place: placeOfScene(b), seen: false }),
      got: metEv.get(id)!.size, of: o.evs.size,
      fates: [...o.fates.keys()].map((k) => fateSeen.has(k) ? { text: o.fates.get(k), ev: evTitle(events.find((e) => e.gua_no === +k.split(":")[0])!), seen: true } : { seen: false }),
      ev: evList(o.evs, metEv.get(id)!),
    } : { seen: false };
  }
  return { places: out, people };
}
