// functions/due-reminder/index.ts — 每日排程做的兩件事
//
// 一、應期到期回訪：掃今日（或更早）到期且未回評的卦，推播提醒＋回評按鈕。
// 二、角色生日信：今天是誰的生日就寄一封廣播進站內信（0061）。
//
// 【為什麼生日信掛在這一支】
//
// 它需要的東西這裡都有：一個每天會被叫起來的排程、一個 service_role 連線。
// 另開一支 function 就要另設一條 pg_cron、另記一個 secret、另擔心它哪天沒被觸發——
// 而生日信一年只寄三次，那三次沒寄成不會有任何人發現。掛在一支每天都在跑的
// 東西上，它壞了你會從應期推播一起發現。
//
// ⚠ 順序：生日信先寄。它是一句 RPC，而應期推播會跑上百次 TG 呼叫——
//   反過來的話，某一次 TG 卡住就會把當天的生日信一起拖掉。
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
  // 內部鑑權：要帶 internal secret（排程呼叫時帶）。
  //
  // 原本是 `if (secret && auth !== secret)`——env 沒設就全放行，等於任何人都能
  // 反覆觸發整批應期推播（一次最多 200 卦，見下方 limit）。broadcast/index.ts:154
  // 一直是 fail-closed 的，這裡是漏網的那一支。改成一致。
  const secret = Deno.env.get("BROADCAST_INTERNAL_SECRET");
  const auth = req.headers.get("x-internal-secret");
  if (!secret || auth !== secret) {
    if (!secret) console.error("BROADCAST_INTERNAL_SECRET 未設定：due-reminder 一律拒絕");
    return new Response("forbidden", { status: 403 });
  }

  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  /* ── 角色生日信 ──────────────────────────────────────────────
     birthday_due() 回的是「今天該寄、且今天還沒寄過的」。判重看的是信本身
     （今天、這個角色、kind='character' 的廣播存不存在），不另存旗標——
     排程重跑或一天被叫兩次都不會寄出第二封。

     寄的是一封廣播（user_id 為 null），不是每人一封：一年三封信要為每個人
     各呼叫一次模型或各寫一列，那是把一封信做成一筆帳單。代價是信裡不會有
     名字，而那對一封「今天我生日」的信來說無所謂。 */
  const birthdays: string[] = [];
  try {
    const { data: due } = await db.rpc("birthday_due");
    for (const c of (due ?? []) as { id: string; name: string; letter: string }[]) {
      const { error: mailErr } = await db.rpc("mail_send", {
        p_user: null,
        p_subject: `${c.name}的生日`,
        p_body: c.letter,
        p_kind: "character",
        p_character: c.id,
      });
      if (mailErr) { console.error("birthday mail failed", c.id, mailErr.message); continue; }
      birthdays.push(c.id);
    }
  } catch (e) {
    // 生日信寄不出去不該讓應期推播整批停擺——那是每天都在跑的正事。
    console.error("birthday block threw", e instanceof Error ? e.message : String(e));
  }

  // 找：應期已到(<=今日)、未回評(verdict is null或0)、未推播過(notified_at is null)的卦
  const { data: dues, error } = await db.from("feedback")
    .select("cast_id, due_date, casts(question, gua_ben, character_id, user_id, reading)")
    .lte("due_date", today)
    .or("verdict.is.null,verdict.eq.0")
    .is("notified_at", null)
    .limit(200);

  if (error) return new Response(JSON.stringify({ error: error.message, birthdays }), { status: 500 });
  if (!dues?.length) return new Response(JSON.stringify({ sent: 0, birthdays, msg: "無到期卦" }));

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

  return new Response(JSON.stringify({ sent, birthdays }));
});
