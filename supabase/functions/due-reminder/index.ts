// functions/due-reminder/index.ts — 應期到期回訪推播器
// 由排程（pg_cron）每日呼叫；掃今日(或更早)到期且未回評的卦，推播提醒＋回評按鈕。
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TG = `https://api.telegram.org/bot${Deno.env.get("TG_BOT_TOKEN")}`;
const CHAR_LABELS: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀貓" };

// 把解卦結論摘成一小段（去 Markdown、優先抓「結論」段、裁到約 160 字）
function summarize(reading: string): string {
  if (!reading) return "";
  let t = reading
    .replace(/^#+\s*/gm, "")        // 標題記號
    .replace(/\*\*/g, "")            // 粗體
    .replace(/\*/g, "")              // 斜體/星號
    .replace(/^[-—]{2,}.*$/gm, "")   // 分隔線
    .replace(/<due>.*?<\/due>/gs, "")// 應期標籤
    .trim();
  // 優先抓「結論」段落
  const m = t.match(/【?結論】?[：:]?\s*([\s\S]{10,})/);
  if (m) t = m[1].trim();
  // 去多餘空行、裁切
  t = t.replace(/\n{2,}/g, "\n").trim();
  if (t.length > 160) t = t.slice(0, 158) + "…";
  return t;
}

async function send(chatId: string, text: string, markup?: unknown) {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) }),
  });
}

Deno.serve(async (req) => {
  // 簡單保護：要帶 internal secret（排程呼叫時帶）
  const secret = Deno.env.get("BROADCAST_INTERNAL_SECRET");
  const auth = req.headers.get("x-internal-secret");
  if (secret && auth !== secret) return new Response("forbidden", { status: 403 });

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  // 找：應期已到(<=今日)、未回評(verdict is null或0)、未推播過(notified_at is null)的卦
  const { data: dues, error } = await db.from("feedback")
    .select("cast_id, due_date, casts(question, gua_ben, character_id, user_id, reading)")
    .lte("due_date", today)
    .or("verdict.is.null,verdict.eq.0")
    .is("notified_at", null)
    .limit(200);

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!dues?.length) return new Response(JSON.stringify({ sent: 0, msg: "無到期卦" }));

  let sent = 0;
  for (const f of dues) {
    const c = f.casts as unknown as { question: string; gua_ben: string; character_id: string; user_id: string; reading: string };
    if (!c) continue;
    // 取用戶 TG chat id
    const { data: idn } = await db.from("identities").select("external_id")
      .eq("user_id", c.user_id).eq("provider", "tg").maybeSingle();
    if (!idn?.external_id) continue;

    const who = CHAR_LABELS[c.character_id] ?? "修行者";
    // 當時結論摘要：去 Markdown 記號，取結論段或前段，裁到約 160 字
    const recap = summarize(c.reading ?? "");
    await send(idn.external_id,
      `📜 <b>應期到了</b>\n\n你曾問${who}：「${c.question ?? ""}」\n《${c.gua_ben}》\n\n` +
      (recap ? `<i>當時${who}說——</i>\n${recap}\n\n` : "") +
      `這一天將盡，卦中所言的時節也到了。<b>後來，結果如何？</b>`,
      { inline_keyboard: [[
        { text: "✅ 應驗了", callback_data: `verdict:${f.cast_id}:1` },
        { text: "◐ 部分準", callback_data: `verdict:${f.cast_id}:2` },
        { text: "✕ 沒準", callback_data: `verdict:${f.cast_id}:3` },
      ]] });
    await db.from("feedback").update({ notified_at: new Date().toISOString() }).eq("cast_id", f.cast_id);
    sent++;
    await new Promise((r) => setTimeout(r, 50));
  }

  return new Response(JSON.stringify({ sent }));
});
