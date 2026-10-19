// functions/weekly-report/index.ts — 產品週報：讀產品數據，經由觀主的管家 bot 送到 TG
//
// 誰會叫它：
//   ・產品專案的 pg_cron，每週一 09:03（台北）
//   ・管家 bot 的 /week（管家在另一個 Supabase 專案，見 mailbot/README.md）
// 兩邊都帶 x-report-secret = REPORT_SECRET（fail-closed）。這把密碼只管「叫週報」這一件事，
// 不跟應期提醒的 BROADCAST_INTERNAL_SECRET 共用——管家專案就算外洩，也只能多叫一份週報。
//
// 為什麼週報留在產品、信箱搬出去：週報看的是產品的數據；信箱是觀主的私事。
import { createClient } from "npm:@supabase/supabase-js@2";
import { weeklyText, type WeeklyStats } from "../_shared/weekly-report.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";

async function say(text: string) {
  const r = await fetch(`https://api.telegram.org/bot${Deno.env.get("ADMIN_BOT_TOKEN")}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: ADMIN_TG_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`TG ${r.status} ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("REPORT_SECRET");
  if (!secret || req.headers.get("x-report-secret") !== secret) {
    if (!secret) console.error("REPORT_SECRET 未設定：weekly-report 一律拒絕");
    return new Response("forbidden", { status: 403 });
  }
  if (!Deno.env.get("ADMIN_BOT_TOKEN")) return Response.json({ ok: false, error: "ADMIN_BOT_TOKEN not set" }, { status: 500 });
  try {
    const { data, error } = await db.rpc("admin_weekly_stats");
    if (error || !data) throw new Error(error?.message ?? "no data");
    await say(weeklyText(data as WeeklyStats));
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("WEEKLY_REPORT_ERROR", msg);
    await say(`⚠️ 產品週報算不出來：${msg.slice(0, 200).replace(/</g, "&lt;")}`).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
