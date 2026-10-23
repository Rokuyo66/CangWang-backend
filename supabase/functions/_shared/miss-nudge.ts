// _shared/miss-nudge.ts — 應期回評「沒準」累積多了，由最常替他起卦的那一位主動提醒（六六 2026-10-23）。
//
// 起因：卦越來越不準時，該換一種起卦方式、起卦前靜心，或給自己一點儀式感（六六上課聽來的）。
// 規則：feedback.verdict = 3（沒準）超過 MISS_NUDGE_AFTER 次就提醒一次；提醒過之後，
// 要再多 MISS_NUDGE_EVERY 次「沒準」才再提醒。看過的那一刻把當時的次數記在 profiles.miss_nudge_at（0105）。
// 0105 沒跑：讀不到欄位就當作不提醒——寧可少講，不要每開一次 App 就跳一次。
// 前端用「對話彈窗」演（美術規範 › 對話彈窗；台詞在前端 src/main/33-guide.js 的 MISS_TALK）。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const MISS_NUDGE_AFTER = 5;   // 「沒準」超過幾次才提醒（第 6 次）
export const MISS_NUDGE_EVERY = 5;   // 提醒過之後，再多幾次才再提醒
const CIDS = ["daoshi_m", "daoshi_f", "lingshou"];

async function missesOf(db: SupabaseClient, uid: string): Promise<number> {
  const { count } = await db.from("feedback").select("cast_id", { count: "exact", head: true })
    .eq("user_id", uid).eq("verdict", 3);
  return count ?? 0;
}

/** 最常替他起卦的那一位（最近 200 卦裡數；同票取最近一次的那位）。一卦都沒有就是大師兄。 */
export async function topCharOf(db: SupabaseClient, uid: string): Promise<string> {
  const { data } = await db.from("casts").select("character_id, created_at").eq("user_id", uid)
    .order("created_at", { ascending: false }).limit(200);
  const n: Record<string, number> = {}; let best = "", bestN = 0;
  for (const r of (data ?? []) as { character_id: string | null }[]) {
    const c = r.character_id; if (!c || !CIDS.includes(c)) continue;
    n[c] = (n[c] ?? 0) + 1;
  }
  // 依最近出現的順序看，> 才換人：同票時留住最近替他起卦的那一位
  for (const r of (data ?? []) as { character_id: string | null }[]) {
    const c = r.character_id; if (c && n[c] > bestN) { best = c; bestN = n[c]; }
  }
  return best || "daoshi_m";
}

/** 現在該不該提醒；該的話回 { cid, misses }。 */
export async function missNudgeOf(db: SupabaseClient, uid: string): Promise<{ cid: string; misses: number } | null> {
  try {
    const misses = await missesOf(db, uid);
    if (misses <= MISS_NUDGE_AFTER) return null;
    const { data: p, error } = await db.from("profiles").select("miss_nudge_at").eq("id", uid).maybeSingle();
    if (error) return null;   // 0105 沒跑
    const seen = Number((p as { miss_nudge_at?: number | null } | null)?.miss_nudge_at ?? 0);
    if (seen && misses < seen + MISS_NUDGE_EVERY) return null;
    return { cid: await topCharOf(db, uid), misses };
  } catch (_) { return null; }
}

/** 看過了：記下當時的「沒準」次數。 */
export async function markMissNudge(db: SupabaseClient, uid: string): Promise<{ ok: boolean; msg?: string }> {
  const misses = await missesOf(db, uid);
  const { error } = await db.from("profiles").update({ miss_nudge_at: misses }).eq("id", uid);
  return error ? { ok: false, msg: error.message } : { ok: true };
}
