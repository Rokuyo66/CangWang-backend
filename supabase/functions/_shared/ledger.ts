// _shared/ledger.ts — 靈石收支的分組與明細。
//
// 為什麼要有這一層：ledger 是一筆一列的流水，直接攤在畫面上，一晚上聊十七句就是十七列
// 「閒聊 −1」，把當天真正該看的東西（加卦扣了幾顆、追問問了什麼）擠到看不見。
// 所以列表改成「當天 × 項目」一列，展開才看得到每一筆。
//
// 分組在後端做而不在前端做，是因為兩件事前端做不了：
//   1. 日界。台北時間 01:22 那筆屬於哪一天，得跟站內其他額度用同一條線（UTC+8）；
//   2. 明細。「這筆加卦買到的是哪一卦」只有 ledger.ref_id 接得回去，前端沒有這張表。
//
// 另外，截斷過的那一天不能顯示。流水取窗查詢必有上限，最舊那天很可能只撈到一半——
// 一列寫著「閒聊 −12」而實際是 −40，比不顯示更糟。寧可整天不給，也不給錯的合計。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** ledger.action → 人看得懂的名字。後台統計與收支列表共用同一份，免得兩處各翻各的。 */
export const LEDGER_LABELS: Record<string, string> = {
  register: "註冊", signin: "簽到", signin_mend: "補簽",
  chat: "閒聊", followup: "追問", extra_cast: "加卦",
  deepen: "展開", deepen_refund: "展開退款", comment: "換評",
  breakthrough: "突破", feedback: "回評",
  post_hot: "熱門貼文", comment_hot: "熱門回文", buy_theme: "解鎖配色",
  admin_grant: "後台發放",   // dev/lingshi.ps1 手動調的那些，別讓它顯示成原始代號
};

export const labelOf = (action: string) => LEDGER_LABELS[action] ?? action;

export type LedgerRow = { id: number; action: string; amount: number; created_at: string; ref_id: string | null };
export type LedgerItem = { id: number; at: string; amount: number; detail: string | null; ref: string | null; refKind: string | null };
export type LedgerGroup = { action: string; label: string; count: number; amount: number; items: LedgerItem[] };
export type LedgerDay = { date: string; income: number; spend: number; net: number; groups: LedgerGroup[] };

/** 這筆流水指向的是一支卦（ref_id 為 cast id）。明細＝那一卦問的事。 */
const CAST_ACTIONS = new Set(["extra_cast", "followup", "deepen", "deepen_refund", "comment", "feedback"]);

/** 台北日界：與免費額度、日運、簽到同一條線。01:22 起的卦算前一天的，畫面才對得起來。 */
export function taipeiDayOf(iso: string) {
  return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

const trim = (s: string | null | undefined, n = 40) =>
  !s ? null : (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 把流水接回它買到的東西。回傳 ledger.id → {detail, ref, refKind}。
 *
 * 追問是唯一接不乾淨的一項：計費在 AI 呼叫之前、追問入庫在之後，ledger.ref_id 存的是
 * 卦 id 而不是追問 id，同一支卦問過幾次就有幾筆對得上。這裡以「同一支卦裡時間最近、
 * 且尚未被別筆認領」的追問來配對——扣款與入庫相隔數秒，十分鐘的容差綽綽有餘；
 * 配不到（AI 當時失敗、沒有入庫）就退回顯示原卦問句，不會憑空掰一句出來。
 */
export async function ledgerDetails(db: SupabaseClient, rows: LedgerRow[]) {
  const out = new Map<number, { detail: string | null; ref: string | null; refKind: string | null }>();

  const castIds = [...new Set(rows.filter((r) => CAST_ACTIONS.has(r.action) && r.ref_id).map((r) => r.ref_id!))];
  const postIds = [...new Set(rows.filter((r) => r.action === "post_hot" && r.ref_id).map((r) => r.ref_id!))];
  const cmtIds = [...new Set(rows.filter((r) => r.action === "comment_hot" && r.ref_id).map((r) => r.ref_id!))];

  const casts = new Map<string, string>();
  const fus = new Map<string, { question: string; at: number; taken: boolean }[]>();
  if (castIds.length) {
    const { data } = await db.from("casts").select("id, question").in("id", castIds);
    for (const c of (data ?? []) as { id: string; question: string | null }[]) casts.set(c.id, c.question ?? "");
    // 只有真的有追問流水時才去撈 followups，免得每次收支查詢都多掃一張表
    if (rows.some((r) => r.action === "followup" && r.ref_id)) {
      const { data: f } = await db.from("followups").select("cast_id, question, created_at").in("cast_id", castIds);
      for (const x of (f ?? []) as { cast_id: string; question: string | null; created_at: string }[]) {
        const list = fus.get(x.cast_id) ?? [];
        list.push({ question: x.question ?? "", at: new Date(x.created_at).getTime(), taken: false });
        fus.set(x.cast_id, list);
      }
    }
  }

  const posts = new Map<string, string>();
  if (postIds.length) {
    const { data } = await db.from("posts").select("id, title").in("id", postIds);
    for (const p of (data ?? []) as { id: string; title: string }[]) posts.set(p.id, p.title);
  }
  const cmts = new Map<string, { post_id: string; body: string }>();
  if (cmtIds.length) {
    const { data } = await db.from("post_comments").select("id, post_id, body").in("id", cmtIds);
    for (const c of (data ?? []) as { id: string; post_id: string; body: string }[]) cmts.set(c.id, c);
  }

  // 追問由舊到新配對：先發生的那筆先挑，順序才不會被後來的搶走
  for (const r of [...rows].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))) {
    if (r.action !== "followup" || !r.ref_id) continue;
    const list = fus.get(r.ref_id);
    if (!list) continue;
    const t = new Date(r.created_at).getTime();
    let best: typeof list[number] | null = null;
    for (const f of list) {
      if (f.taken || Math.abs(f.at - t) > 10 * 60_000) continue;
      if (!best || Math.abs(f.at - t) < Math.abs(best.at - t)) best = f;
    }
    if (best) { best.taken = true; out.set(r.id, { detail: trim(best.question), ref: r.ref_id, refKind: "cast" }); }
  }

  for (const r of rows) {
    if (out.has(r.id)) continue;   // 追問已配到自己的問句，別被原卦問句蓋掉
    if (CAST_ACTIONS.has(r.action) && r.ref_id) {
      out.set(r.id, { detail: trim(casts.get(r.ref_id)), ref: r.ref_id, refKind: "cast" });
    } else if (r.action === "post_hot" && r.ref_id) {
      out.set(r.id, { detail: trim(posts.get(r.ref_id)), ref: r.ref_id, refKind: "post" });
    } else if (r.action === "comment_hot" && r.ref_id) {
      const c = cmts.get(r.ref_id);
      out.set(r.id, { detail: trim(c?.body), ref: c?.post_id ?? null, refKind: c ? "post" : null });
    } else {
      out.set(r.id, { detail: null, ref: null, refKind: null });
    }
  }
  return out;
}

/**
 * 依「台北日 × 項目」分組。rows 需為新→舊（查詢已這樣排）。
 *
 * 排序不必另外做：Map 保留插入順序，而 rows 是新→舊，所以天與群組的先後
 * 自然就是「最近發生的排前面」，群組內也維持新→舊。讀起來仍是一條時間線，
 * 只是同名項目收成了一列。
 *
 * income 為正、spend 為負（保持與每一筆同號，前端要顯示絕對值自己取），net 為兩者相加。
 */
export function groupLedger(
  rows: LedgerRow[],
  details: Map<number, { detail: string | null; ref: string | null; refKind: string | null }>,
): LedgerDay[] {
  const days = new Map<string, Map<string, LedgerGroup>>();
  for (const r of rows) {
    const date = taipeiDayOf(r.created_at);
    const byAction = days.get(date) ?? new Map<string, LedgerGroup>();
    days.set(date, byAction);
    const g = byAction.get(r.action) ?? { action: r.action, label: labelOf(r.action), count: 0, amount: 0, items: [] };
    const d = details.get(r.id);
    g.count += 1;
    g.amount += r.amount;
    g.items.push({ id: r.id, at: r.created_at, amount: r.amount, detail: d?.detail ?? null, ref: d?.ref ?? null, refKind: d?.refKind ?? null });
    byAction.set(r.action, g);
  }
  return [...days.entries()].map(([date, byAction]) => {
    const groups = [...byAction.values()];
    return {
      date,
      income: groups.reduce((s, g) => s + g.items.reduce((a, i) => a + Math.max(0, i.amount), 0), 0),
      spend: groups.reduce((s, g) => s + g.items.reduce((a, i) => a + Math.min(0, i.amount), 0), 0),
      net: groups.reduce((s, g) => s + g.amount, 0),
      groups,
    };
  });
}
