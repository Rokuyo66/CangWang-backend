// dev/weekly-report-test.mts — 產品週報的排版（_shared/weekly-report.ts）。
//
// 數字在 SQL（admin_weekly_stats）；這裡守的是：留存、毛利、準驗率算得對，空資料不炸，
// 而且週報裡不再出現信箱的東西（管家已搬到獨立專案）。
//
// 跑法：node dev/weekly-report-test.mts

import { weeklyText, delta } from "../supabase/functions/_shared/weekly-report.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
};
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`得到 ${JSON.stringify(a)}，應為 ${JSON.stringify(b)}`); };

t("delta：新／持平／升降", () => {
  eq(delta(5, 0), "（新）"); eq(delta(0, 0), ""); eq(delta(10, 10), "（持平）");
  eq(delta(12, 10), "（▲20%）"); eq(delta(5, 10), "（▼50%）");
});

t("週報算得出留存與毛利，空資料不炸", () => {
  const s = weeklyText({
    from: "2026-10-05", to: "2026-10-11",
    cur: { new_users: 12, active_users: 40, casts: 100, casts_web: 30, followups: 20, chats: 300, verdicts: 4, verdict_hit: 3, lingshi_spent: 500, revenue_twd: 900, payments: 3, ai_twd: 400 },
    prv: { active_users: 20 }, retained: 10,
    casts_by_char: { daoshi_f: 60, lingshou: 40 }, casts_by_cat: { 感情: 50 },
    by_day: { "2026-10-06": 20, "2026-10-07": 25 },
  });
  for (const k of ["50%（10/20）", "毛利 NT$ <b>500</b>", "師妹 60", "10-07", "準 75%"]) if (!s.includes(k)) throw new Error(`少了「${k}」`);
  weeklyText({ from: "", to: "", cur: {}, prv: {}, retained: 0, casts_by_char: {}, casts_by_cat: {}, by_day: {} });
});

t("產品週報不再帶信箱", () => {
  const s = weeklyText({ from: "a", to: "b", cur: {}, prv: {}, retained: 0, casts_by_char: {}, casts_by_cat: {}, by_day: {} });
  if (/信箱|待辦|清理/.test(s)) throw new Error("產品週報還有信箱的段落");
});

setTimeout(() => {
  console.log(`\n${pass} 過、${fail} 敗`);
  if (fail) process.exit(1);
});
