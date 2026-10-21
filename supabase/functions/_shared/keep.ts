// _shared/keep.ts — 卦的保存期限與搜尋
//
// 規則本身住在 SQL（0087：cast_keep_days／cast_is_kept／cleanup_expired_casts），
// 這裡只負責把它查出來、換算成畫面上的「剩 N 天」。不在 TS 另抄一份規則：
// 抄了就會有一天「畫面寫永久、清理照刪」。
//
// 前端契約見 dev/web/CAST-SEARCH-API.md。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** 無牒的保存天數。與 0087 cast_keep_days() 的 90 同一個數字，只用來在查詢失敗時兜底與給前端顯示。 */
export const FREE_KEEP_DAYS = 90;
/** 日運卦的保存天數（不分方案、不受保護）。同 0087 cleanup_expired_casts() 的 7 天。 */
export const FORTUNE_KEEP_DAYS = 7;
/** 斷牒後仍照原方案保存的緩衝天數。同 0087。 */
export const KEEP_GRACE_DAYS = 30;

/** 剩幾天算「快到期」：前端標紅、提醒最急的那一段 */
export const KEEP_SOON_DAYS = 14;

const MAX_Q = 50;      // 搜尋字串上限（字元）
const MAX_TERMS = 5;   // 關鍵字上限

export type CastKeep = {
  /** 此刻的保存天數；null＝永久（藏往） */
  days: number | null;
  /** 斷牒緩衝期截止（ISO）；不在緩衝期為 null */
  graceUntil: string | null;
};

export async function castKeepOf(db: SupabaseClient, uid: string): Promise<CastKeep> {
  const { data, error } = await db.rpc("cast_keep_of", { p_user: uid });
  const row = (Array.isArray(data) ? data[0] : data) as { keep_days: number | null; grace_until: string | null } | null;
  // 查不到（0087 未跑、帳號沒有 profile）：照無牒報。寧可少報幾天，不能多報。
  if (error || !row) return { days: FREE_KEEP_DAYS, graceUntil: null };
  return { days: row.keep_days ?? null, graceUntil: row.grace_until ?? null };
}

/** 搜尋字串整理：去頭尾、壓空白、限長、限關鍵字數。空字串回 null（不搜）。 */
export function normalizeSearchQuery(raw: unknown): string | null {
  const s = String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, MAX_Q).trim();
  if (!s) return null;
  return s.split(" ").slice(0, MAX_TERMS).join(" ");
}

/** 到期時點 → 剩幾天（向下取整，最少 0）。null＝永久。 */
export function daysLeft(expiresAt: string | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 86_400_000));
}

type SearchRow = {
  id: string; question: string | null; digest: string | null; gua_ben: string; gua_bian: string | null;
  category: string | null; character_id: string | null; created_at: string; due_date: string | null;
  thread_id: string | null; verdict: number | null; kept: boolean; expires_at: string | null;
};

export type SearchHit = Omit<SearchRow, "expires_at"> & { expiresAt: string | null; daysLeft: number | null };

export async function searchCasts(
  db: SupabaseClient, uid: string,
  opts: { q: unknown; before?: unknown; limit?: unknown },
): Promise<{ kind: "ok"; query: string; casts: SearchHit[]; nextBefore: string | null; keep: CastKeep & { freeDays: number } } | { kind: "err"; msg: string }> {
  const q = normalizeSearchQuery(opts.q);
  if (!q) return { kind: "err", msg: "要找什麼？打個字。" };
  const before = typeof opts.before === "string" && !isNaN(Date.parse(opts.before)) ? opts.before : null;
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 30));

  const [{ data, error }, keep] = await Promise.all([
    db.rpc("search_casts", { p_user: uid, p_q: q, p_before: before, p_limit: limit }),
    castKeepOf(db, uid),
  ]);
  if (error) return { kind: "err", msg: "搜尋失敗，稍後再試。" };

  const now = Date.now();
  const rows = (data ?? []) as SearchRow[];
  const casts = rows.map(({ expires_at, ...r }) => ({ ...r, expiresAt: expires_at, daysLeft: daysLeft(expires_at, now) }));
  return {
    kind: "ok", query: q, casts,
    // 滿頁才有下一頁；給最後一筆的 created_at，下次原樣帶回 before
    nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null,
    keep: { ...keep, freeDays: FREE_KEEP_DAYS },
  };
}
