// ============================================================
// supabase/functions/broadcast/index.ts
// 觀主廣播 — 實際發送器
//
// 職責：
//   1. 被 webhook-tg 在「你按下確認」後呼叫（帶 broadcast_id）
//   2. 讀 identities 表所有 tg 用戶 = 廣播名單
//   3. 分批節流發送（避開 Telegram 速率限制），處理 429 重試
//   4. 把成功/失敗數寫回 broadcasts 表
//   5. 用 EdgeRuntime.waitUntil 在背景跑，立刻回 200（不卡住呼叫端）
//
// 安全：只接受帶正確 x-internal-secret 標頭的請求（webhook-tg 才知道）。
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---- 環境變數（用 supabase secrets set 設定）----
const TG_BOT_TOKEN      = Deno.env.get("TG_BOT_TOKEN")!;        // ← 若你的密鑰名不同，改這裡
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET   = Deno.env.get("BROADCAST_INTERNAL_SECRET")!;

const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

// ---- 節流參數 ----
// Telegram bot 群發上限約每秒 30 則。保守設成 ~22/秒，留安全邊際。
const BATCH_SIZE     = 25;     // 每批人數
const BATCH_PAUSE_MS = 1100;   // 每批之間休息（毫秒）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 發單則訊息；遇到 429 依 retry_after 重試一次；其餘錯誤回 false
async function tgSend(
  chatId: string,
  text: string,
  parseMode: string | null,
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;

      const data = await res.json().catch(() => ({}));
      // 429 = 被限速，Telegram 會告訴你要等幾秒
      if (res.status === 429 && data?.parameters?.retry_after) {
        await sleep((data.parameters.retry_after + 1) * 1000);
        continue; // 重試一次
      }
      // 403 = 用戶封鎖了 bot / 刪帳號 → 算失敗，不重試
      return false;
    } catch (_e) {
      await sleep(500);
    }
  }
  return false;
}

async function runBroadcast(
  supabase: ReturnType<typeof createClient>,
  broadcastId: string,
) {
  // 1. 取出這次廣播
  const { data: bc, error } = await supabase
    .from("broadcasts")
    .select("*")
    .eq("id", broadcastId)
    .single();

  if (error || !bc) {
    console.error("找不到廣播", broadcastId, error);
    return;
  }
  if (bc.status !== "pending") {
    console.log("廣播狀態非 pending，略過：", bc.status);
    return;
  }

  // 2. 撈名單：所有 tg 渠道身分。external_id 即私聊 chat_id。
  const { data: ids, error: idErr } = await supabase
    .from("identities")
    .select("external_id")
    .eq("provider", "tg");

  if (idErr) {
    await supabase.from("broadcasts").update({
      status: "failed",
      finished_at: new Date().toISOString(),
    }).eq("id", broadcastId);
    console.error("讀名單失敗", idErr);
    return;
  }

  const recipients = (ids ?? [])
    .map((r) => String(r.external_id))
    .filter(Boolean);

  await supabase.from("broadcasts").update({
    status: "sending",
    total: recipients.length,
    started_at: new Date().toISOString(),
  }).eq("id", broadcastId);

  // 3. 分批送
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((cid) => tgSend(cid, bc.body, bc.parse_mode)),
    );
    for (const ok of results) ok ? sent++ : failed++;

    // 即時回寫進度（讓你能在 DB 看到跑到哪）
    await supabase.from("broadcasts")
      .update({ sent, failed })
      .eq("id", broadcastId);

    if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_PAUSE_MS);
  }

  // 4. 收尾
  await supabase.from("broadcasts").update({
    status: "done",
    sent,
    failed,
    finished_at: new Date().toISOString(),
  }).eq("id", broadcastId);

  // 5. 回報給管理員本人（用 created_by 當 chat_id）
  if (bc.created_by) {
    await tgSend(
      bc.created_by,
      `✅ 廣播完成\n總人數 ${recipients.length}｜成功 ${sent}｜失敗 ${failed}`,
      null,
    );
  }

  console.log(`廣播 ${broadcastId} 完成：${sent}/${recipients.length}`);
}

Deno.serve(async (req) => {
  // 內部鑑權：只有帶對的 secret 才放行
  if (req.headers.get("x-internal-secret") !== INTERNAL_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let broadcastId: string;
  try {
    ({ broadcast_id: broadcastId } = await req.json());
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (!broadcastId) return new Response("missing broadcast_id", { status: 400 });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const task = runBroadcast(supabase, broadcastId);

  // 背景跑：立刻回 200，發送在後台繼續（避免 webhook 端等太久）
  // @ts-ignore EdgeRuntime 為 Supabase 提供的全域
  if (typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(task);
  } else {
    await task;
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
