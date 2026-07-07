// ============================================================
// supabase/functions/_shared/broadcast-command.ts
//
// 把這個模組 import 進你現有的 webhook-tg，在最前面攔截 /broadcast 相關事件。
// 它只處理「管理員下廣播指令」這條線，其餘 update 一律放行回你的原邏輯。
//
// 用法（在 webhook-tg/index.ts 收到 update 之後、進入你原本的指令路由之前）：
//
//   import { tryHandleBroadcast } from "../_shared/broadcast-command.ts";
//   ...
//   const handled = await tryHandleBroadcast(update, supabase);
//   if (handled) return new Response("ok"); // 廣播指令已處理，結束
//   // ↓ 以下接你原本的 /start /gua /ask … 路由
//
// ============================================================

const TG_BOT_TOKEN    = Deno.env.get("TG_BOT_TOKEN")!;
const INTERNAL_SECRET = Deno.env.get("BROADCAST_INTERNAL_SECRET")!;
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;

// 管理員 tg_user_id —— 只有這個人能下 /broadcast。
// 預設值是你的 ID；建議改用 secret（見下方註解），別人就算知道指令也用不了。
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";

const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

async function tg(method: string, payload: Record<string, unknown>) {
  return fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// 觸發背景發送器
async function fireBroadcast(broadcastId: string) {
  await fetch(`${SUPABASE_URL}/functions/v1/broadcast`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": INTERNAL_SECRET,
    },
    body: JSON.stringify({ broadcast_id: broadcastId }),
  });
}

/**
 * 嘗試處理廣播相關 update。
 * 回傳 true = 已處理（呼叫端應結束）；false = 不是廣播事件，放行。
 */
export async function tryHandleBroadcast(
  // deno-lint-ignore no-explicit-any
  update: any,
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<boolean> {
  // ---------- A. 文字指令 /broadcast ----------
  const msg = update.message;
  if (msg?.text) {
    const text: string = msg.text;
    const fromId = String(msg.from?.id ?? "");
    const chatId = String(msg.chat?.id ?? "");

    if (text.startsWith("/broadcast")) {
      // 非管理員 → 直接無視（裝作沒這指令）
      if (fromId !== ADMIN_TG_ID) return true;

      const body = text.replace(/^\/broadcast(@\w+)?\s*/, "").trim();
      if (!body) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "用法：/broadcast 你要廣播的內容\n\n例如：\n/broadcast 🩸 觀主廣播 v1.4.0\n新增了 OO 功能…",
        });
        return true;
      }

      // 存成草稿
      const { data, error } = await supabase
        .from("broadcasts")
        .insert({ body, created_by: fromId, status: "draft", parse_mode: "HTML" })
        .select("id")
        .single();

      if (error || !data) {
        await tg("sendMessage", { chat_id: chatId, text: "⚠️ 草稿建立失敗，稍後再試。" });
        return true;
      }

      // 預覽 + 確認按鈕（顯示名單人數）
      const { count } = await supabase
        .from("identities")
        .select("external_id", { count: "exact", head: true })
        .eq("provider", "tg");

      await tg("sendMessage", {
        chat_id: chatId,
        text:
          `📢 廣播預覽（共 ${count ?? "?"} 位 tg 用戶）\n` +
          `────────────\n${body}\n────────────\n確認發送？`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ 確認發送", callback_data: `bc_go:${data.id}` },
            { text: "✖️ 取消",     callback_data: `bc_no:${data.id}` },
          ]],
        },
      });
      return true;
    }
    return false; // 其他文字訊息，放行
  }

  // ---------- B. 確認/取消 按鈕回呼 ----------
  const cq = update.callback_query;
  if (cq?.data && (cq.data.startsWith("bc_go:") || cq.data.startsWith("bc_no:"))) {
    const fromId = String(cq.from?.id ?? "");
    const chatId = String(cq.message?.chat?.id ?? "");
    const msgId  = cq.message?.message_id;
    const [action, bcId] = cq.data.split(":");

    // 非管理員按鈕 → 拒絕
    if (fromId !== ADMIN_TG_ID) {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "無權限" });
      return true;
    }

    if (action === "bc_no") {
      await supabase.from("broadcasts").update({ status: "cancelled" }).eq("id", bcId);
      await tg("editMessageText", {
        chat_id: chatId, message_id: msgId, text: "✖️ 已取消這則廣播。",
      });
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      return true;
    }

    // bc_go：確認發送
    const { data: bc } = await supabase
      .from("broadcasts").select("status").eq("id", bcId).single();
    if (!bc || bc.status !== "draft") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "此廣播已處理過" });
      return true;
    }

    await supabase.from("broadcasts").update({ status: "pending" }).eq("id", bcId);
    await tg("editMessageText", {
      chat_id: chatId, message_id: msgId,
      text: "🚀 開始發送中…完成後會回報結果。",
    });
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "已開始發送" });

    // 觸發背景發送器（不等它跑完）
    await fireBroadcast(bcId);
    return true;
  }

  return false; // 不是廣播事件
}
