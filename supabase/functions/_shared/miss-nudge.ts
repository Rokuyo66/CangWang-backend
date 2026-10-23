// _shared/miss-nudge.ts — 應期回評最近一直「沒準」，由最常替他起卦的那一位主動提醒（六六 2026-10-23）。
//
// 起因：卦越來越不準時，該換一種起卦方式、起卦前靜心，或給自己一點儀式感（六六上課聽來的）。
// 規則（同日改：看最近的比例，不看累計總數——累計會太慢，也分不出「問了一百卦錯六次」與「連三次全錯」）：
//   最近 RECENT 次回評裡，「沒準」（verdict 3）算 1、「部分準」（2）算 0.5，加起來 ≥ MISS_SCORE 就提醒；
//   回評不滿 MIN_REVIEWS 次不算（太少看不出趨勢）；提醒過之後 COOLDOWN_DAYS 天內不再跳。
// 看過的那一刻記在 profiles.miss_nudge_seen_at（0105）。0105 沒跑：讀不到欄位就當作不提醒。
// 前端用「對話彈窗」演（美術規範 › 對話彈窗；台詞在前端 src/main/33-guide.js 的 MISS_TALK）。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const RECENT = 5;          // 看最近幾次回評
export const MISS_SCORE = 3;      // 沒準＋半個部分準 加起來到幾
export const MIN_REVIEWS = 3;     // 至少回評幾次才開始算
export const COOLDOWN_DAYS = 30;  // 提醒過之後幾天內不再跳
const CIDS = ["daoshi_m", "daoshi_f", "lingshou"];

/** 最近 RECENT 次回評的分數與次數（沒準 1、部分準 0.5、準 0）。 */
async function recentOf(db: SupabaseClient, uid: string): Promise<{ score: number; n: number; misses: number }> {
  const { data } = await db.from("feedback").select("verdict, answered_at").eq("user_id", uid)
    .in("verdict", [1, 2, 3]).order("answered_at", { ascending: false }).limit(RECENT);
  const rows = (data ?? []) as { verdict: number }[];
  let score = 0, misses = 0;
  for (const r of rows) { if (r.verdict === 3) { score += 1; misses++; } else if (r.verdict === 2) score += 0.5; }
  return { score, n: rows.length, misses };
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

/** 現在該不該提醒；該的話回 { cid, misses, of }（最近 of 次裡沒準 misses 次，台詞用）。 */
export async function missNudgeOf(db: SupabaseClient, uid: string, now = Date.now()): Promise<{ cid: string; misses: number; of: number } | null> {
  try {
    const r = await recentOf(db, uid);
    if (r.n < MIN_REVIEWS || r.score < MISS_SCORE) return null;
    const { data: p, error } = await db.from("profiles").select("miss_nudge_seen_at").eq("id", uid).maybeSingle();
    if (error) return null;   // 0105 沒跑
    const seen = (p as { miss_nudge_seen_at?: string | null } | null)?.miss_nudge_seen_at;
    if (seen && now - Date.parse(seen) < COOLDOWN_DAYS * 86400000) return null;
    return { cid: await topCharOf(db, uid), misses: r.misses, of: r.n };
  } catch (_) { return null; }
}

/** 看過了：記下時間，冷卻從這裡算。 */
export async function markMissNudge(db: SupabaseClient, uid: string): Promise<{ ok: boolean; msg?: string }> {
  const { error } = await db.from("profiles").update({ miss_nudge_seen_at: new Date().toISOString() }).eq("id", uid);
  return error ? { ok: false, msg: error.message } : { ok: true };
}
