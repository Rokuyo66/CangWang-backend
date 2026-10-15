// _shared/mailbot-tg.ts — 信箱管家在 webhook-tg 裡的那一半：觀主的指令與按鈕
//
//   /mail_help         說明
//   /mailnow           立刻整理一輪（不等排程）
//   /mailask           把還沒決定的信再推一次
//   /maillog           最近自動刪掉的 10 封，附「救回」鈕
//   /mailrules         列出規則
//   /mailrule del N    刪第 N 條規則
//   /mailrule add 動作 種類 內容   例：/mailrule add trash domain shopee.tw
//   /week              立刻出一份產品週報
//
// 呼叫端（webhook-tg）已確認是觀主才進來；這裡不再驗身分。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { trash, untrash } from "./gmail.ts";
import {
  esc, askText, askButtons, parseMbCallback, mbCallback, weeklyText,
  KIND_LABEL, ACTION_LABEL, type Rule, type WeeklyStats,
} from "./mailbot.ts";

type Send = (text: string, extra?: Record<string, unknown>) => Promise<unknown>;

export const MAILBOT_HELP =
  "<b>📬 信箱管家</b>\n\n" +
  "每兩小時自動整理收件匣：該刪的丟垃圾桶、該你知道的匯報、拿不準的問你。\n" +
  "你按的每個「以後都…」都會變成一條規則，下次就不問了。\n\n" +
  "<code>/mailnow</code>　立刻整理一輪\n" +
  "<code>/mailask</code>　還沒決定的再推一次\n" +
  "<code>/maillog</code>　最近自動刪的信（可救回）\n" +
  "<code>/mailrules</code>　看規則\n" +
  "<code>/mailrule del 編號</code>　刪規則\n" +
  "<code>/mailrule add trash|report|keep sender|domain|subject 內容</code>\n" +
  "<code>/week</code>　立刻出產品週報";

const MAILBOT_CMD = /^\/(mail_help|mailnow|mailask|maillog|mailrules|mailrule|week)(@\w+)?(\s|$)/;
export const isMailbotCommand = (text: string) => MAILBOT_CMD.test(text);

async function fireJob(job: "triage" | "weekly") {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/mail-butler`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": Deno.env.get("BROADCAST_INTERNAL_SECRET") ?? "" },
    body: JSON.stringify({ job }),
  });
  return res.json().catch(() => ({ ok: res.ok }));
}

export async function handleMailbotCommand(db: SupabaseClient, text: string, send: Send): Promise<void> {
  const cmd = text.match(MAILBOT_CMD)?.[1] ?? "";
  const arg = text.replace(MAILBOT_CMD, "").trim();

  if (cmd === "mail_help") { await send(MAILBOT_HELP); return; }

  if (cmd === "week") {
    const { data, error } = await db.rpc("admin_weekly_stats");
    await send(error || !data ? `週報算不出來：${esc(error?.message ?? "no data")}` : weeklyText(data as WeeklyStats));
    return;
  }

  if (cmd === "mailnow") {
    await send("📬 整理中…");
    const r = await fireJob("triage") as Record<string, unknown>;
    if (!r?.ok) { await send(`整理失敗：${esc(String(r?.error ?? "unknown"))}`); return; }
    if (!r.fresh) await send(`沒有新信（近 3 天收件匣 ${r.scanned ?? 0} 封都看過了）。`);
    return;
  }

  if (cmd === "mailask") {
    const { data } = await db.from("mailbot_seen")
      .select("id, sender, sender_name, subject, snippet, reason")
      .eq("status", "open").order("created_at", { ascending: true }).limit(10);
    if (!data?.length) { await send("沒有待決的信。"); return; }
    for (const r of data) {
      await send(askText({ from: `${r.sender_name} <${r.sender}>`, subject: r.subject ?? "", snippet: r.snippet ?? "", reason: r.reason ?? "" }),
        { reply_markup: { inline_keyboard: askButtons(r.id) } });
    }
    return;
  }

  if (cmd === "maillog") {
    const { data } = await db.from("mailbot_seen")
      .select("id, sender, sender_name, subject, source, created_at")
      .eq("decision", "trash").neq("source", "user").order("created_at", { ascending: false }).limit(10);
    if (!data?.length) { await send("最近沒有自動刪掉的信。"); return; }
    await send("<b>最近自動刪掉的信</b>　按 ♻ 救回並記一條「這寄件人以後留著」",
      { reply_markup: { inline_keyboard: data.map((r) => [{
        text: `♻ ${String(r.sender_name ?? r.sender).slice(0, 14)}｜${String(r.subject ?? "").slice(0, 22)}`,
        callback_data: mbCallback("u", r.id),
      }]) } });
    return;
  }

  if (cmd === "mailrules") {
    const { data } = await db.from("mailbot_rules").select("id, kind, pattern, action, hits")
      .order("action").order("hits", { ascending: false }).limit(80);
    if (!data?.length) { await send("還沒有規則。從「要刪嗎」那幾顆按鈕按出來，或 /mailrule add。"); return; }
    const lines = (data as (Rule & { hits: number })[]).map((r) =>
      `#${r.id} ${ACTION_LABEL[r.action]}　${KIND_LABEL[r.kind]} <code>${esc(r.pattern)}</code>　命中 ${r.hits}`);
    await send(`<b>📬 信箱規則（${data.length}）</b>\n\n${lines.join("\n")}\n\n<i>刪規則：/mailrule del 編號</i>`);
    return;
  }

  if (cmd === "mailrule") {
    const del = arg.match(/^del\s+(\d+)$/i);
    if (del) {
      const { data } = await db.from("mailbot_rules").delete().eq("id", Number(del[1])).select("id");
      await send(data?.length ? `🗑 已刪規則 #${del[1]}` : `沒有 #${del[1]} 這條。`);
      return;
    }
    const add = arg.match(/^add\s+(trash|report|keep)\s+(sender|domain|subject)\s+(.+)$/i);
    if (add) {
      const rule = { action: add[1].toLowerCase(), kind: add[2].toLowerCase(), pattern: add[3].trim().toLowerCase().slice(0, 200) };
      const { data, error } = await db.from("mailbot_rules")
        .upsert(rule, { onConflict: "kind,pattern" }).select("id").single();
      await send(error ? `記不下來：${esc(error.message)}`
        : `✅ 規則 #${data.id}：${KIND_LABEL[rule.kind as Rule["kind"]]} <code>${esc(rule.pattern)}</code> → ${ACTION_LABEL[rule.action as Rule["action"]]}`);
      return;
    }
    await send(MAILBOT_HELP);
  }
}

/** 按鈕：mb:<op>:<id>。回 false＝不是信箱管家的按鈕。 */
export async function handleMailbotCallback(
  db: SupabaseClient, data: string, send: Send, clearButtons: () => Promise<unknown>,
): Promise<boolean> {
  const cb = parseMbCallback(data);
  if (!cb) return false;
  const { data: row } = await db.from("mailbot_seen")
    .select("id, gmail_id, sender, sender_name, subject, status, decision").eq("id", cb.id).maybeSingle();
  if (!row) { await send("找不到這封信的紀錄。"); return true; }
  const now = new Date().toISOString();
  const domain = String(row.sender ?? "").split("@").pop() ?? "";

  if (cb.op === "u") {
    try { await untrash(row.gmail_id); } catch (e) { await send(`救不回來：${esc(String(e).slice(0, 150))}`); return true; }
    await db.from("mailbot_seen").update({ decision: "keep", source: "user", status: "done", decided_at: now }).eq("id", row.id);
    await db.from("mailbot_rules").upsert({ kind: "sender", pattern: row.sender, action: "keep", note: "從 /maillog 救回" }, { onConflict: "kind,pattern" });
    await send(`♻ 已救回「${esc(row.subject ?? "")}」，並記下 <code>${esc(row.sender)}</code> 以後留著不刪。`);
    return true;
  }

  if (row.status !== "open") { await clearButtons(); await send("這封已經處理過了。"); return true; }

  const isTrash = cb.op === "t" || cb.op === "T" || cb.op === "D";
  if (isTrash) {
    try { await trash(row.gmail_id); } catch (e) { await send(`刪不掉：${esc(String(e).slice(0, 150))}`); return true; }
  }
  await db.from("mailbot_seen")
    .update({ decision: isTrash ? "trash" : cb.op === "K" ? "report" : "keep", source: "user", status: "done", decided_at: now })
    .eq("id", row.id);
  await clearButtons();

  let rule: { kind: Rule["kind"]; pattern: string; action: Rule["action"] } | null = null;
  if (cb.op === "T") rule = { kind: "sender", pattern: row.sender, action: "trash" };
  if (cb.op === "D" && domain) rule = { kind: "domain", pattern: domain, action: "trash" };
  if (cb.op === "K") rule = { kind: "sender", pattern: row.sender, action: "report" };

  let extra = "";
  if (rule) {
    const { data: r } = await db.from("mailbot_rules").upsert({ ...rule, note: "TG 按鈕" }, { onConflict: "kind,pattern" }).select("id").single();
    extra = `\n📏 新規則 #${r?.id ?? "?"}：${KIND_LABEL[rule.kind]} <code>${esc(rule.pattern)}</code> → ${ACTION_LABEL[rule.action]}`;
    // 同一個寄件人／網域還在待決清單裡的，一併照新規則處理，不必再一封一封按
    let q = db.from("mailbot_seen").select("id, gmail_id").eq("status", "open").neq("id", row.id);
    q = rule.kind === "domain" ? q.or(`sender.like.%@${domain},sender.like.%.${domain}`) : q.eq("sender", row.sender);
    const { data: same } = await q.limit(50);
    let n = 0;
    for (const s of same ?? []) {
      if (rule.action === "trash") { try { await trash(s.gmail_id); } catch { continue; } }
      await db.from("mailbot_seen").update({ decision: rule.action, source: "rule", status: "done", decided_at: now }).eq("id", s.id);
      n++;
    }
    if (n) extra += `\n（待決清單裡同來源的 ${n} 封也一併處理了）`;
  }
  const what = isTrash ? "🗑 已刪" : cb.op === "K" ? "📌 已留" : "📥 已留";
  await send(`${what}：${esc(String(row.subject ?? "").slice(0, 60))}${extra}`);
  return true;
}
