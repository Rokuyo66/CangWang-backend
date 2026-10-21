// _shared/jianghu-run.ts — 江湖尋訪的伺服端服務層（資料表與發獎在 0095_jianghu.sql，規則在 jianghu.ts）。
//
// 四支：今天的江湖（profile 帶）、開一趟、走完、成就榜＋領獎。
// 進度與獎勵一律在這裡判：客戶端只送「選了哪些 key」，結局是這裡照劇本重演算出來的。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { walk, clientDoc, litAchievements, achievementsOf, movingOf, rollMoving, alias, STATS_DEFAULT, type Doc } from "./jianghu.ts";

export type JhResult = { ok: true; payload: Record<string, unknown> } | { ok: false; msg: string };
const bad = (msg: string): JhResult => ({ ok: false, msg });
const good = (payload: Record<string, unknown>): JhResult => ({ ok: true, payload });

/** 台北日期（與日運、簽到同一條日界） */
export const taipeiDay = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

async function config(db: SupabaseClient) {
  // select *：stats 欄是 0098 才加的，沒跑 0098 也不會整支失敗
  const { data } = await db.from("jianghu_config").select("*").eq("id", "main").maybeSingle();
  const stats = Array.isArray(data?.stats) && data.stats.length ? data.stats as { k: string; name: string }[] : STATS_DEFAULT;
  return { replayCost: (data?.replay_cost as number | undefined) ?? 10, alias: (data?.alias ?? {}) as Record<string, string>, stats };
}
/** 今天的日運卦（名字＋動爻）。沒抽＝null */
async function todayFortune(db: SupabaseClient, uid: string, day: string) {
  const { data } = await db.from("casts").select("gua_ben, lines, created_at").eq("user_id", uid).eq("category", "日運")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const at = new Date(new Date(data.created_at as string).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return at === day ? { gua: data.gua_ben as string, moving: movingOf(data.lines as number[]) } : null;
}
async function eventOf(db: SupabaseClient, by: { gua?: string; no?: number }, anyStatus = false) {
  let q = db.from("jianghu_events").select("gua_no, gua, title, doc, published");
  q = by.no ? q.eq("gua_no", by.no) : q.eq("gua", by.gua ?? "");
  const { data } = await q.maybeSingle();
  if (!data || (!anyStatus && !data.published)) return null;
  return data as { gua_no: number; gua: string; title: string; doc: Doc; published: boolean };
}
/** 今天的卦還沒有劇本時先走這一篇（六六 2026-10-21：驗證期一律導向乾為天）。0＝不導，照實說「尚在鋪設」 */
const FALLBACK_GUA = Number(Deno.env.get("JIANGHU_FALLBACK_GUA") ?? "1");
async function eventForToday(db: SupabaseClient, gua: string) {
  const ev = await eventOf(db, { gua });
  if (ev) return { ev, fallback: false };
  const fb = FALLBACK_GUA ? await eventOf(db, { no: FALLBACK_GUA }) : null;
  return { ev: fb, fallback: !!fb };
}
const titleId = (gua: number, endingId: string) =>
  `jh${String(gua).padStart(2, "0")}_${endingId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 60);

/** profile 帶的「今天的江湖」：觀堂那一條要畫「卦名，江湖尋訪（免費／💎N）」 */
export async function jianghuToday(db: SupabaseClient, uid: string) {
  try {
    const day = taipeiDay();
    const f = await todayFortune(db, uid, day);
    if (!f) return null;
    const { ev, fallback } = await eventForToday(db, f.gua);
    const { count } = await db.from("jianghu_runs").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day);
    const cfg = await config(db);
    return { gua: f.gua, ready: !!ev, fallback, event_gua: ev?.gua ?? null, title: ev?.title ?? null, gua_no: ev?.gua_no ?? null,
      summary: ev ? (ev.doc.outline?.player_summary ?? "") : "", visited: (count ?? 0) > 0, cost: cfg.replayCost };
  } catch (_) { return null; }
}

/** 開一趟。isAdmin 時可指定卦（不管今天抽到什麼）與動爻——觀主試玩用，照樣扣錢、照樣發獎 */
export async function jianghuStart(db: SupabaseClient, uid: string, isAdmin: boolean, body: Record<string, unknown>): Promise<JhResult> {
  const day = taipeiDay();
  const cfg = await config(db);
  const f = await todayFortune(db, uid, day);
  const test = isAdmin && body.gua_no != null;
  let ev;
  if (test) ev = await eventOf(db, { no: Number(body.gua_no) }, true);
  else {
    if (!f) return bad("今天還沒求日運籤");
    ev = (await eventForToday(db, f.gua)).ev;
  }
  if (!ev) return bad("這一卦的江湖之路尚在鋪設");
  const pickMoving = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => x >= 0 && x <= 5))].sort() : null;
  const free = test ? (pickMoving(body.moving) ?? (f && f.gua === ev.gua ? f.moving : [])) : f!.moving;
  const { data: prof } = await db.from("profiles").select("display_name").eq("id", uid).maybeSingle();
  const name = body.name === "alias"
    ? alias(`${day}|${ev.gua_no}|${uid}`, cfg.alias)
    : (String(prof?.display_name ?? "").trim().slice(0, 12) || "無名");
  const { data: r, error } = await db.rpc("jianghu_start", {
    p_user: uid, p_gua: ev.gua_no, p_day: day, p_moving_free: free, p_moving_roll: rollMoving(),
    p_name: name, p_cost: cfg.replayCost, p_test: test,
  });
  if (error || !r) { console.error("jianghu_start", error); return bad("江湖路斷，稍後再試"); }
  if (!r.ok) return r.reason === "lingshi" ? bad(`靈石不足：再走一趟要 ${r.cost} 顆`) : bad("開不了這一趟");
  return good({ run_id: r.run_id, moving: r.moving, cost: r.cost, balance: r.balance ?? null, resumed: r.resumed,
    name, gua: ev.gua, gua_no: ev.gua_no, doc: clientDoc(ev.doc), stats: cfg.stats.map((x) => ({ k: x.k, name: x.name })) });
}

async function finishedRuns(db: SupabaseClient, uid: string, gua: number) {
  const { data } = await db.from("jianghu_runs").select("ending_id, changes, items")
    .eq("user_id", uid).eq("gua_no", gua).not("finished_at", "is", null);
  return ((data ?? []) as { ending_id: string; changes: number[]; items: string[] }[]).filter((r) => r.ending_id);
}

/** 走完。picks＝每個選擇點選的 key（依序）。伺服器重演一次判結局 */
export async function jianghuFinish(db: SupabaseClient, uid: string, body: Record<string, unknown>): Promise<JhResult> {
  const runId = String(body.run_id ?? "");
  const picks = Array.isArray(body.picks) ? body.picks.map(String).slice(0, 200) : null;
  if (!runId || !picks) return bad("少了這一趟的紀錄");
  const { data: run } = await db.from("jianghu_runs").select("id, gua_no, moving, name, finished_at")
    .eq("id", runId).eq("user_id", uid).maybeSingle();
  if (!run) return bad("查無這一趟");
  if (run.finished_at) return bad("這一趟已經走完了");
  const ev = await eventOf(db, { no: run.gua_no as number }, true);
  if (!ev) return bad("劇本不見了");
  const w = walk(ev.doc, (run.moving ?? []) as number[], picks);
  if (!w.ok) { console.error("jianghu walk", runId, w.err); return bad("這一趟的路對不上劇本（劇本可能剛改過），請重走一次"); }
  const en = w.ending;
  const before = new Set(litAchievements(ev.doc, await finishedRuns(db, uid, ev.gua_no)));
  const pt = en.player_title?.label?.trim();
  const hook = en.hook && en.hook.who && String(en.hook.memory ?? "").trim() ? en.hook : null;
  const { data: r, error } = await db.rpc("jianghu_finish", {
    p_user: uid, p_run: runId, p_ending: en.id, p_picks: picks, p_items: w.items, p_flags: w.flags, p_changes: w.changes,
    p_reward: Math.max(0, Math.min(1000, Number(en.reward_lingshi) || 0)),
    p_title_id: pt ? titleId(ev.gua_no, en.id) : null, p_title_label: pt || null,
    p_title_note: pt ? `江湖・${ev.gua}「${en.title}」` : null,
    p_hook_who: hook ? hook.who : null, p_hook_memory: hook ? String(hook.memory) : null,
  });
  if (error || !r?.ok) { console.error("jianghu_finish", error ?? r); return bad("這一趟沒記上，請再試一次"); }
  const lit = litAchievements(ev.doc, await finishedRuns(db, uid, ev.gua_no));
  const newly = achievementsOf(ev.doc).filter((a) => lit.includes(a.id) && !before.has(a.id)).map((a) => ({ id: a.id, name: a.name, reward: a.reward_lingshi ?? 0 }));
  const nm = (s: string | undefined) => String(s ?? "").replaceAll("{名}", run.name as string);
  const found = new Set((await finishedRuns(db, uid, ev.gua_no)).map((x) => x.ending_id));
  return good({
    ending: { id: en.id, title: en.title, rare: !!en.rare, text: nm(en.text), insight: en.insight ?? "", npc_fate: en.npc_fate ?? "",
      title_desc: en.player_title?.desc ?? "" },
    first: !!r.first, rewards: r.rewards ?? {},
    hook: en.hook && en.hook.who && en.hook.ask ? { who: en.hook.who, ask: nm(en.hook.ask) } : null,
    achievements: newly, found: found.size, total: ev.doc.endings.length,
  });
}

/** 成就榜：每一篇上架的江湖（觀主連未上架的也看得到），結局剪影＋成就與領取狀態 */
export async function jianghuBoard(db: SupabaseClient, uid: string, isAdmin: boolean): Promise<JhResult> {
  let q = db.from("jianghu_events").select("gua_no, gua, title, doc, published").order("gua_no");
  if (!isAdmin) q = q.eq("published", true);
  const { data: evs } = await q;
  const { data: claims } = await db.from("jianghu_claims").select("gua_no, ach_id").eq("user_id", uid);
  const claimed = new Set((claims ?? []).map((c: { gua_no: number; ach_id: string }) => `${c.gua_no}:${c.ach_id}`));
  const out = [];
  for (const ev of (evs ?? []) as { gua_no: number; gua: string; title: string; doc: Doc; published: boolean }[]) {
    const runs = await finishedRuns(db, uid, ev.gua_no);
    const found = new Set(runs.map((r) => r.ending_id));
    const lit = new Set(litAchievements(ev.doc, runs));
    out.push({
      gua_no: ev.gua_no, gua: ev.gua, title: ev.title, published: ev.published, runs: runs.length,
      endings: ev.doc.endings.map((e) => found.has(e.id) ? { title: e.title, rare: !!e.rare, found: true } : { title: "", rare: !!e.rare, found: false }),
      achievements: achievementsOf(ev.doc).map((a) => ({ id: a.id, name: a.name, desc: a.desc ?? "", reward: a.reward_lingshi ?? 0,
        state: claimed.has(`${ev.gua_no}:${a.id}`) ? "claimed" : lit.has(a.id) ? "lit" : "locked" })),
    });
  }
  return good({ events: out });
}

export async function jianghuClaim(db: SupabaseClient, uid: string, body: Record<string, unknown>): Promise<JhResult> {
  const gua = Number(body.gua_no), achId = String(body.ach_id ?? "");
  const ev = await eventOf(db, { no: gua }, true);
  if (!ev) return bad("查無這一卦");
  const a = achievementsOf(ev.doc).find((x) => x.id === achId);
  if (!a) return bad("查無這個成就");
  if (!litAchievements(ev.doc, await finishedRuns(db, uid, gua)).includes(achId)) return bad("還沒達成");
  const amount = Math.max(0, Math.min(1000, Number(a.reward_lingshi) || 0));
  const { data: r, error } = await db.rpc("jianghu_claim", { p_user: uid, p_gua: gua, p_ach: achId, p_amount: amount });
  if (error || !r) { console.error("jianghu_claim", error); return bad("領取沒能存住，請再試一次"); }
  if (!r.ok) return bad("已經領過了");
  return good({ ach_id: achId, amount, balance: r.balance ?? null });
}
