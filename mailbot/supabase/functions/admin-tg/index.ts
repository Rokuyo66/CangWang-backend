// functions/admin-tg/index.ts — 觀主私人的管家 bot（JjizhiMailbot）的 webhook
//
// 為什麼不跟卜卦 bot（webhook-tg）共用：
//   ・改管家就得重新部署對外服務，一次部署失誤兩邊一起壞
//   ・指令會撞名（/mail 站內信 vs /mailnow）
//   ・觀主的私人信件標題與摘要不該流經對外產品的程式與日誌
//   ・同一把 token 外洩或被限流，產品通道與管家同時斷
//
// 這個 bot 只認觀主一人（ADMIN_TG_ID），其他人傳什麼都不回——不回應，就不會讓人知道它是誰的。
// 鑑權：Telegram 帶來的 x-telegram-bot-api-secret-token 必須等於 ADMIN_TG_WEBHOOK_SECRET（fail-closed）。
import { createClient } from "npm:@supabase/supabase-js@2";
import { isMailbotCommand, handleMailbotCommand, handleMailbotCallback, handleMailbotFreeText, MAILBOT_HELP } from "../_shared/mailbot-tg.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TG = `https://api.telegram.org/bot${Deno.env.get("ADMIN_BOT_TOKEN")}`;
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";

async function tg(method: string, payload: Record<string, unknown>) {
  try {
    const r = await fetch(`${TG}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!r.ok) console.error("TG_FAIL", method, r.status, (await r.text()).slice(0, 200));
    else await r.body?.cancel();
  } catch (e) {
    console.error("TG_THROW", method, e instanceof Error ? e.message : String(e));
  }
}

const send = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// 輸入框左邊的「選單」：/start 時順手設一次，不必另外去 BotFather 一條條打
const COMMANDS = [
  { command: "mailnow", description: "立刻整理一輪信箱" },
  { command: "mailtidy", description: "大掃除：收件匣全部推卡" },
  { command: "mailask", description: "還沒按的歸檔卡再推一次" },
  { command: "maillog", description: "最近自動刪的信（可救回）" },
  { command: "mailrules", description: "看規則" },
  { command: "week", description: "產品週報" },
  { command: "due", description: "接下來的到期日" },
  { command: "bills", description: "這個月的帳單與訂閱" },
  { command: "news", description: "航空城・客運園區政府消息" },
  { command: "mail_help", description: "說明" },
];

// deno-lint-ignore no-explicit-any
async function onUpdate(update: any) {
  const fromId = String(update?.message?.from?.id ?? update?.callback_query?.from?.id ?? "");
  if (fromId !== ADMIN_TG_ID) return;   // 私人 bot：陌生人一律不理

  if (update.callback_query) {
    const cb = update.callback_query;
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    const chatId = cb.message?.chat?.id as number | undefined;
    const mid = cb.message?.message_id as number | undefined;
    if (!chatId) return;
    const handled = await handleMailbotCallback(db, String(cb.data ?? ""), (t, extra) => send(chatId, t, extra),
      () => mid ? tg("editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }) : Promise.resolve());
    if (!handled) await send(chatId, "（這顆按鈕已經失效。）");
    return;
  }

  const msg = update.message;
  const chatId = msg?.chat?.id as number | undefined;
  const text = String(msg?.text ?? "").trim();
  if (!chatId || !text) return;

  if (text === "/start" || text === "/help") {
    await tg("setMyCommands", { commands: COMMANDS });
    await send(chatId, MAILBOT_HELP);
    return;
  }
  if (isMailbotCommand(text)) {
    await handleMailbotCommand(db, text, (t, extra) => send(chatId, t, extra));
    return;
  }
  if (text.startsWith("/")) { await send(chatId, "沒有這個指令。打 /mail_help 看指令。"); return; }
  // 一般句子：當成「用說的改規則」，先回確認卡，按 ✅ 才生效
  await handleMailbotFreeText(db, text, (t, extra) => send(chatId, t, extra));
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("ADMIN_TG_WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    if (!secret) console.error("ADMIN_TG_WEBHOOK_SECRET 未設定：admin-tg 一律拒絕");
    return new Response("forbidden", { status: 403 });
  }
  // deno-lint-ignore no-explicit-any
  let update: any = null;
  try {
    update = await req.json();
    await onUpdate(update);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("ADMIN_TG_ERROR", e instanceof Error ? e.stack ?? detail : detail);
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    const fromId = String(update?.message?.from?.id ?? update?.callback_query?.from?.id ?? "");
    if (chatId && fromId === ADMIN_TG_ID) await tg("sendMessage", { chat_id: chatId, text: `⚠️ 管家出錯：${detail.slice(0, 300)}` });
  }
  return new Response("ok"); // 永遠 200，避免 TG 重送風暴
});
