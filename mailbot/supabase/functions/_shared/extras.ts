// _shared/extras.ts — 管家的四個延伸功能（碰資料庫與 Gmail 的那一半；判斷與文案在 mailbot.ts）
//
//   一、到期日提醒：分類時順手抓信裡的日期 → 前一天、當天 09 點後推 TG，按「處理好了」就停
//   二、客服信：寄到客服信箱的信讀內文、分類、寫回信草稿放進 Gmail 草稿匣（只寫不寄）
//   三、帳單月報：扣款／收據讀內文抓金額 → 每月 1 號 09 點後出上個月的月報
//   四、政府消息：每週一用網路搜尋（只搜 gov.tw 與機場公司）整理航空城、客運園區的新公告
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getBody, createReplyDraft, type MailMeta } from "./gmail.ts";
import { ask, askWithSearch } from "./claude.ts";
import {
  esc, parseFrom, mbCallback, reminderDue, reminderText, taipeiDate, taipeiHour,
  SUPPORT_SYS, SUPPORT_CATS, parseSupport, CHARGE_SYS, parseCharges, toTwd, monthlyText,
  newsSys, parseNews, newsText, NEWS_DOMAINS, type AiVerdict, type ChargeRow, type ReminderItem,
} from "./mailbot.ts";

type Say = (text: string, extra?: Record<string, unknown>) => Promise<unknown>;

export const SUPPORT_ADDRESS = Deno.env.get("SUPPORT_ADDRESS") ?? "support@jizhiguan.com";
// 匯率只用來把外幣帳單換成台幣好加總，不求精準；要改就設 secret：USD_TWD=32.5,JPY_TWD=0.21
const RATES: Record<string, number> = { USD: 32, JPY: 0.21, EUR: 35, ...Object.fromEntries(
  (Deno.env.get("FX_TWD") ?? "").split(",").map((kv) => kv.split("=")).filter(([k, v]) => k && Number(v) > 0)
    .map(([k, v]) => [k.trim().toUpperCase().replace(/_TWD$/, ""), Number(v)])) };
const NEWS_TOPICS = Deno.env.get("NEWS_TOPICS") ??
  "・桃園航空城計畫（區段徵收、安置街廓、都市計畫、配地、工程進度）\n・桃園機場客運園區（含 A 區、B 區、周邊產專區與住宅區）\n・機場捷運、第三航廈、周邊道路與聯外交通";

/* ── 一、到期日提醒 ─────────────────────────────────────────── */

export async function recordReminder(db: SupabaseClient, m: MailMeta, v: AiVerdict | null) {
  const due = reminderDue(v?.due, taipeiDate());
  if (!due) return;
  const f = parseFrom(m.from);
  await db.from("mailbot_reminders").upsert({
    gmail_id: m.id, thread_id: m.threadId, due_date: due, what: (v?.dw ?? "").slice(0, 60) || null,
    sender: f.name.slice(0, 80), subject: m.subject.slice(0, 200),
  }, { onConflict: "gmail_id", ignoreDuplicates: true });
}

/** 每輪整理都會叫；09 點以後才推，同一件事前一天、當天各推一次。排程某一輪失敗，下一輪會補。 */
export async function sendDueReminders(db: SupabaseClient, say: Say): Promise<number> {
  if (taipeiHour() < 9) return 0;
  const today = taipeiDate(), tomorrow = taipeiDate(Date.now(), 1);
  const { data: rows } = await db.from("mailbot_reminders")
    .select("id, due_date, what, sender, subject, notified_before, notified_day")
    .eq("done", false).in("due_date", [today, tomorrow]);
  const todays = (rows ?? []).filter((r) => r.due_date === today && !r.notified_day) as (ReminderItem & { notified_day: boolean })[];
  const tomorrows = (rows ?? []).filter((r) => r.due_date === tomorrow && !r.notified_before) as ReminderItem[];
  if (!todays.length && !tomorrows.length) return 0;
  const all = [...todays, ...tomorrows];
  await say(reminderText(todays, tomorrows), { reply_markup: { inline_keyboard: all.slice(0, 8).map((r) => [{
    text: `✓ 處理好了：${String(r.what || r.subject || "").slice(0, 20)}`, callback_data: mbCallback("R", r.id),
  }]) } });
  if (todays.length) await db.from("mailbot_reminders").update({ notified_day: true, notified_before: true }).in("id", todays.map((r) => r.id));
  if (tomorrows.length) await db.from("mailbot_reminders").update({ notified_before: true }).in("id", tomorrows.map((r) => r.id));
  return all.length;
}

/* ── 二、客服信 ─────────────────────────────────────────────── */

/** 讀內文、分類、寫回信草稿。回卡片要加的那幾行；失敗回 null（卡片照推，只是沒有草稿）。 */
export async function handleSupport(m: MailMeta): Promise<{ head: string; sum: string } | null> {
  try {
    const body = await getBody(m.id, 4000);
    const r = parseSupport(await ask(SUPPORT_SYS, `寄件人：${m.from}\n主旨：${m.subject}\n\n${body}`, { maxTokens: 1500 }));
    if (!r) return null;
    const replyTo = parseFrom(m.from).email;
    let drafted = false;
    // 先以客服地址當寄件人；客服地址若不是 Gmail 裡設好的「傳送郵件身分」會被拒，就退回用本帳號
    const draft = { threadId: m.threadId, to: replyTo, subject: m.subject, inReplyTo: m.messageId, body: r.reply };
    for (const from of [SUPPORT_ADDRESS, undefined]) {
      try { await createReplyDraft({ ...draft, from }); drafted = true; break; }
      catch (e) { console.error("createReplyDraft failed", from ?? "(default)", e instanceof Error ? e.message : String(e)); }
    }
    const link = `https://mail.google.com/mail/u/0/#inbox/${m.threadId}`;
    return {
      head: `🎧 <b>客服來信</b>　${SUPPORT_CATS[r.cat] ?? r.cat}${r.urgent ? "　🚨 <b>急</b>" : ""}\n` +
        (drafted ? `📝 回信草稿已放在 <a href="${link}">這串信</a> 裡，看過、改過再自己送出` : "⚠️ 草稿沒寫成，請直接到 Gmail 回"),
      sum: r.sum,
    };
  } catch (e) {
    console.error("handleSupport failed", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/* ── 三、帳單月報 ───────────────────────────────────────────── */

/** 一批扣款信讀內文抓金額，寫進 mailbot_charges。每輪最多 max 封，多的下一輪不會再看（信已處理過）——寧可少記，不拖住整理。 */
export async function recordCharges(db: SupabaseClient, metas: MailMeta[], max = 10): Promise<number> {
  const batch = metas.slice(0, max);
  if (!batch.length) return 0;
  const bodies = await Promise.all(batch.map((m) => getBody(m.id, 1500).catch(() => m.snippet)));
  const prompt = batch.map((m, i) => `#${i}\n寄件人：${m.from}\n主旨：${m.subject}\n${bodies[i]}`).join("\n\n");
  const parsed = parseCharges(await ask(CHARGE_SYS, prompt, { maxTokens: 80 * batch.length + 200 }), batch.length);
  const rows = parsed.flatMap((c, i) => c ? [{
    gmail_id: batch[i].id, vendor: c.vendor, currency: c.currency, amount: c.amount, twd: toTwd(c, RATES),
    kind: c.kind, sub: c.sub, charged_at: batch[i].receivedAt,
  }] : []);
  if (rows.length) await db.from("mailbot_charges").upsert(rows, { onConflict: "gmail_id", ignoreDuplicates: true });
  return rows.length;
}

/** month＝YYYY-MM（台北）。回 [當月, 上個月] 的明細。 */
export async function chargesOf(db: SupabaseClient, month: string): Promise<[ChargeRow[], ChargeRow[]]> {
  const [y, mo] = month.split("-").map(Number);
  const start = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1) - 8 * 3600_000).toISOString();
  const cur0 = start(y, mo), next0 = start(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1), prev0 = start(mo === 1 ? y - 1 : y, mo === 1 ? 12 : mo - 1);
  const q = async (a: string, b: string) => ((await db.from("mailbot_charges").select("vendor, currency, amount, twd, kind, sub")
    .gte("charged_at", a).lt("charged_at", b)).data ?? []).map((r) => ({ ...r, amount: Number(r.amount), twd: r.twd == null ? null : Number(r.twd) })) as ChargeRow[];
  return [await q(cur0, next0), await q(prev0, cur0)];
}

/** 每月 1 號 09 點後，出上個月的月報（同一個月只出一次）。 */
export async function sendMonthlyIfDue(db: SupabaseClient, say: Say): Promise<boolean> {
  const today = taipeiDate();
  if (today.slice(8) !== "01" && today.slice(8) !== "02") return false;   // 1 號那天整天排程都壞了，2 號補
  if (taipeiHour() < 9) return false;
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const { data: st } = await db.from("mailbot_state").select("value").eq("key", "monthly_sent").maybeSingle();
  if (st?.value === last) return false;
  const [cur, prev] = await chargesOf(db, last);
  await say(monthlyText(last, cur, prev));
  await db.from("mailbot_state").upsert({ key: "monthly_sent", value: last, updated_at: new Date().toISOString() });
  return true;
}

/* ── 四、政府消息 ───────────────────────────────────────────── */

export async function sendNews(db: SupabaseClient, say: Say): Promise<number> {
  const items = parseNews(await askWithSearch(newsSys(NEWS_TOPICS), `今天是 ${taipeiDate()}（台北）。請找最近 10 天的新公告。`, NEWS_DOMAINS));
  // 推過的不再推
  const { data: seen } = items.length ? await db.from("mailbot_news").select("url").in("url", items.map((x) => x.url)) : { data: [] };
  const seenSet = new Set((seen ?? []).map((r) => r.url));
  const fresh = items.filter((x) => !seenSet.has(x.url));
  await say(newsText(fresh), { disable_web_page_preview: true });
  if (fresh.length) await db.from("mailbot_news").upsert(fresh.map((x) => ({ url: x.url, title: x.title, published: x.date || null })), { onConflict: "url", ignoreDuplicates: true });
  return fresh.length;
}

export { esc };
