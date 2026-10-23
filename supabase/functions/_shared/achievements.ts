// _shared/achievements.ts — 成就榜的「問事」與「道緣」兩格（0106，六六 2026-10-23）。
//
// 江湖的成就一卦一份，寫在劇本裡（jianghu.ts）；這兩格是全站一份，寫在這裡。
// 亮不亮：問事看 ach_progress（只增不減的次數），道緣看 user_character_events（完成過哪些角色事件）。
// 領：ach_claim（0106），主鍵仲裁、發石記在 ledger 的 'ach'。
//
// 加一個成就＝在 ACH 加一列。id 一旦上線就不要改——ach_claims 用它記「領過了」。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type AchCat = "ask" | "dy";
type Rule =
  | { kind: "count"; key: string; n: number }        // ach_progress[key] ≥ n
  | { kind: "event"; character: string };             // 這位角色的事件完成過任一則
export type AchDef = { id: string; cat: AchCat; name: string; desc: string; reward: number; rule: Rule };

/* 問事：問卦次數一條線（1→100），再來是「第一次換個方式起卦」一組。名字取自易傳與卦爻辭。 */
export const ACH: AchDef[] = [
  { id: "ask_1",   cat: "ask", name: "初筮",     desc: "第一次問卦。蒙：初筮告。",                 reward: 10,  rule: { kind: "count", key: "cast", n: 1 } },
  { id: "ask_5",   cat: "ask", name: "履霜",     desc: "問過五卦。履霜，堅冰至——都是一點一點積起來的。", reward: 15,  rule: { kind: "count", key: "cast", n: 5 } },
  { id: "ask_10",  cat: "ask", name: "十朋之龜", desc: "問過十卦。或益之十朋之龜，弗克違。",         reward: 20,  rule: { kind: "count", key: "cast", n: 10 } },
  { id: "ask_20",  cat: "ask", name: "積小高大", desc: "問過二十卦。升：君子以順德，積小以高大。",   reward: 30,  rule: { kind: "count", key: "cast", n: 20 } },
  { id: "ask_30",  cat: "ask", name: "恆其德",   desc: "問過三十卦。恆：立不易方。",                 reward: 40,  rule: { kind: "count", key: "cast", n: 30 } },
  { id: "ask_50",  cat: "ask", name: "大衍",     desc: "問過五十卦。大衍之數五十。",                 reward: 60,  rule: { kind: "count", key: "cast", n: 50 } },
  { id: "ask_100", cat: "ask", name: "百慮一致", desc: "問過一百卦。天下同歸而殊塗，一致而百慮。",   reward: 100, rule: { kind: "count", key: "cast", n: 100 } },

  { id: "via_chat",      cat: "ask", name: "感而遂通", desc: "第一次從談心起卦。寂然不動，感而遂通。",     reward: 10, rule: { kind: "count", key: "via:chat", n: 1 } },
  { id: "via_agenda",    cat: "ask", name: "與時偕行", desc: "第一次拿手機裡的行程起卦。",               reward: 10, rule: { kind: "count", key: "via:agenda", n: 1 } },
  { id: "method_num",    cat: "ask", name: "參伍以變", desc: "第一次報三數起卦。參伍以變，錯綜其數。",   reward: 10, rule: { kind: "count", key: "method:num", n: 1 } },
  { id: "method_manual", cat: "ask", name: "觀象玩辭", desc: "第一次手動排盤。居則觀其象而玩其辭。",     reward: 10, rule: { kind: "count", key: "method:manual", n: 1 } },
  { id: "review_1",      cat: "ask", name: "彰往察來", desc: "第一次回報應期準不準。",                   reward: 10, rule: { kind: "count", key: "review", n: 1 } },

  /* 道緣：角色事件綁道緣與修為，開得慢——先放一條，完成任一則就能領。 */
  { id: "dy_daoshi_m", cat: "dy", name: "麗澤", desc: "陪大師兄走完一則角色事件。麗澤，兌；君子以朋友講習。", reward: 30, rule: { kind: "event", character: "daoshi_m" } },
];

export type AchState = "locked" | "lit" | "claimed";
export type AchRow = { id: string; cat: AchCat; name: string; desc: string; reward: number; state: AchState; have?: number; need?: number };

/** 起卦成功後記進度。問事頁自己寫的不記 via；舊前端不送 method 就不記 method。 */
export async function bumpCast(db: SupabaseClient, uid: string, via?: string | null, method?: string | null) {
  const keys = ["cast"];
  if (via === "chat" || via === "agenda") keys.push(`via:${via}`);
  if (method === "num" || method === "manual") keys.push(`method:${method}`);
  const { error } = await db.rpc("ach_bump", { p_user: uid, p_keys: keys });
  // 記不下來不該讓起卦失敗（卦錢已扣、批文已出）
  if (error) console.error("ach_bump", error.message);
}

export async function bumpReview(db: SupabaseClient, uid: string) {
  const { error } = await db.rpc("ach_bump", { p_user: uid, p_keys: ["review"] });
  if (error) console.error("ach_bump review", error.message);
}

/** 這個人每一條成就的狀態。表還沒建（migration 未套）就回 null——前端照「暫時讀不到」畫。 */
export async function achBoard(db: SupabaseClient, uid: string): Promise<AchRow[] | null> {
  const [prog, claims, evs] = await Promise.all([
    db.from("ach_progress").select("key, n").eq("user_id", uid),
    db.from("ach_claims").select("ach_id").eq("user_id", uid),
    db.from("user_character_events").select("event_id, character_events!inner(character_id)")
      .eq("user_id", uid).not("completed_at", "is", null),
  ]);
  if (prog.error || claims.error) { console.error("achBoard", prog.error ?? claims.error); return null; }
  const n = new Map((prog.data ?? []).map((r: { key: string; n: number }) => [r.key, r.n]));
  const got = new Set((claims.data ?? []).map((r: { ach_id: string }) => r.ach_id));
  const doneChars = new Set<string>();
  for (const r of (evs.data ?? []) as { character_events: { character_id: string } | { character_id: string }[] }[]) {
    const ce = Array.isArray(r.character_events) ? r.character_events[0] : r.character_events;
    if (ce?.character_id) doneChars.add(ce.character_id);
  }
  return ACH.map((a) => {
    const reached = a.rule.kind === "count" ? (n.get(a.rule.key) ?? 0) >= a.rule.n : doneChars.has(a.rule.character);
    const row: AchRow = { id: a.id, cat: a.cat, name: a.name, desc: a.desc, reward: a.reward,
      state: got.has(a.id) ? "claimed" : reached ? "lit" : "locked" };
    // 次數那一條線帶進度（3／5），沒亮的時候畫得出還差多少
    if (a.rule.kind === "count" && a.rule.n > 1) { row.have = Math.min(n.get(a.rule.key) ?? 0, a.rule.n); row.need = a.rule.n; }
    return row;
  });
}

/** 有幾個亮著還沒領（道籍紅點用）。讀不到就當 0，不為了紅點擋整包 profile。 */
export async function achLitCount(db: SupabaseClient, uid: string): Promise<number> {
  try { return (await achBoard(db, uid))?.filter((r) => r.state === "lit").length ?? 0; } catch (_) { return 0; }
}

export async function achClaim(db: SupabaseClient, uid: string, achId: string):
    Promise<{ ok: true; amount: number; balance: number | null } | { ok: false; msg: string }> {
  const a = ACH.find((x) => x.id === achId);
  if (!a) return { ok: false, msg: "查無這個成就" };
  const board = await achBoard(db, uid);
  const row = board?.find((x) => x.id === achId);
  if (!row) return { ok: false, msg: "成就暫時讀不到" };
  if (row.state === "claimed") return { ok: false, msg: "已經領過了" };
  if (row.state !== "lit") return { ok: false, msg: "還沒達成" };
  const { data: r, error } = await db.rpc("ach_claim", { p_user: uid, p_ach: achId, p_amount: a.reward });
  if (error || !r) { console.error("ach_claim", error); return { ok: false, msg: "領取沒能存住，請再試一次" }; }
  if (!r.ok) return { ok: false, msg: "已經領過了" };
  return { ok: true, amount: a.reward, balance: r.balance ?? null };
}
