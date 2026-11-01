// _shared/weekly-report.ts — 產品週報的文案（純函式，node 測得到）
//
// 數字由 admin_weekly_stats()（0091／0094）算，這裡只排版。發送在 functions/weekly-report。
// 信箱管家已搬到獨立專案（mailbot/），這份週報只談產品。

export const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");


type Week = Record<string, number>;
export type WeeklyStats = {
  from: string; to: string; cur: Week; prv: Week; retained: number;
  casts_by_char: Record<string, number>; casts_by_cat: Record<string, number>;
  by_day: Record<string, number>;
};

/** 本週 vs 上週：▲12%／▼5%／持平／新（上週 0）。 */
export function delta(cur: number, prv: number): string {
  if (!prv) return cur ? "（新）" : "";
  const p = Math.round(((cur - prv) / prv) * 100);
  return p === 0 ? "（持平）" : p > 0 ? `（▲${p}%）` : `（▼${-p}%）`;
}

const CHAR_LABELS: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀貓" };

export function weeklyText(s: WeeklyStats): string {
  const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");
  const c = s.cur ?? {}, p = s.prv ?? {};
  const row = (label: string, k: string) => `${label} <b>${n(c[k])}</b>${delta(Number(c[k] ?? 0), Number(p[k] ?? 0))}`;
  const retainBase = Number(p.active_users ?? 0);
  const retain = retainBase ? `${Math.round((s.retained / retainBase) * 100)}%（${s.retained}/${retainBase}）` : "—";
  const hit = Number(c.verdicts ?? 0) ? `${Math.round((Number(c.verdict_hit ?? 0) / Number(c.verdicts)) * 100)}%` : "—";
  const margin = Number(c.revenue_twd ?? 0) - Number(c.ai_twd ?? 0);
  const days = Object.entries(s.by_day ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const peak = days.reduce((best, d) => (d[1] > best[1] ? d : best), ["", -1] as [string, number]);
  const chars = Object.entries(s.casts_by_char ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(CHAR_LABELS[k] ?? k)} ${n(v)}`).join("　") || "—";
  const cats = Object.entries(s.casts_by_cat ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} ${n(v)}`).join("　") || "—";

  return [
    `📊 <b>藏往知來・週報</b>　${esc(s.from)} ～ ${esc(s.to)}`,
    `<i>括號內為與前一週相比</i>`,
    "",
    `<b>👥 用戶</b>`,
    `${row("新註冊", "new_users")}　${row("週活躍", "active_users")}`,
    `留存（上週活躍、本週回來）${retain}`,
    peak[1] >= 0 ? `最熱的一天 ${esc(peak[0].slice(5))}（${n(peak[1])} 人）` : null,
    "",
    `<b>🔮 使用</b>`,
    `${row("起卦", "casts")}（網頁／App ${n(c.casts_web)}）　${row("追問", "followups")}`,
    `${row("閒聊", "chats")}`,
    `角色：${chars}`,
    `問事：${cats}`,
    `回評 ${n(c.verdicts)} 則，準 ${hit}`,
    "",
    `<b>💰 營收與成本</b>`,
    `${row("收入 NT$", "revenue_twd")}（${n(c.payments)} 筆扣款）`,
    `${row("AI 成本 NT$", "ai_twd")}`,
    `毛利 NT$ <b>${n(margin)}</b>　靈石消耗 ${n(c.lingshi_spent)}`,
  ].filter((l) => l !== null).join("\n");
}
