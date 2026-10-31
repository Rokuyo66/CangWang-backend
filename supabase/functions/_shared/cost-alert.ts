// _shared/cost-alert.ts — 每日 AI 成本告警（推到觀主的 Telegram）
//
// 網頁是公開的，免費帳號也在花 AI 錢。被人寫迴圈狂打、某個模型漲價、新模型沒進
// model_prices（成本全落進 unpriced、帳上看起來是零）——這三種都不會讓任何東西壞掉，
// 只會在月底帳單上出現。這支每天看一次前 24 小時，超過門檻才推。
//
// 掛在 due-reminder（每天都會被排程叫起來的那一支），不另開 function、不另設 pg_cron。
//
// 門檻走環境變數：AI_COST_ALERT_TWD（預設 100）。2026-10-19 實測一週 NT$144，
// 一天約 20，預設是平常的五倍——推的時候就是真的有事。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { esc, notifyAdmin } from "./notify-admin.ts";

export const ALERT_TWD = Number(Deno.env.get("AI_COST_ALERT_TWD") ?? "100");

type ModeRow = { calls: number; twd: number; unpriced?: number };
export type AiCost = {
  calls: number;
  calls_unpriced: number;
  twd: number;
  active_users: number;
  by_mode?: Record<string, ModeRow>;
};

/** 該不該推、推什麼。不需要推就回 null。純函式，測試直接餵 ai_cost 的回傳。 */
export function costAlertText(r: AiCost, limit = ALERT_TWD): string | null {
  const over = r.twd > limit;
  const unpriced = (r.calls_unpriced ?? 0) > 0;
  if (!over && !unpriced) return null;

  const lines: string[] = [];
  if (over) lines.push(`⚠️ <b>AI 成本超標</b>：前 24 小時 NT$${r.twd}（門檻 ${limit}）`);
  if (unpriced) lines.push(`⚠️ <b>有 ${r.calls_unpriced} 次呼叫沒有單價</b>：model_prices 缺模型，上面的金額偏低`);
  lines.push(`呼叫 ${r.calls} 次，活躍 ${r.active_users} 人`);

  const top = Object.entries(r.by_mode ?? {})
    .sort((a, b) => b[1].twd - a[1].twd)
    .slice(0, 3)
    .map(([m, v]) => `· ${esc(m)}：NT$${v.twd}（${v.calls} 次${v.unpriced ? `，未定價 ${v.unpriced}` : ""}）`);
  if (top.length) lines.push("花最多的：", ...top);
  return lines.join("\n");
}

/** 查前 24 小時並視情況推播。失敗只記 log，不拋——不能拖住應期推播。 */
export async function checkAiCost(db: SupabaseClient): Promise<{ twd: number; alerted: boolean } | null> {
  try {
    const { data, error } = await db.rpc("ai_cost", { p_days: 1 });
    if (error || !data) {
      console.error("ai_cost check failed", error?.message);
      return null;
    }
    const r = data as AiCost;
    const text = costAlertText(r);
    if (text) await notifyAdmin(text);
    return { twd: r.twd, alerted: !!text };
  } catch (e) {
    console.error("ai_cost check threw", e instanceof Error ? e.message : String(e));
    return null;
  }
}
