// functions/mail-butler/index.ts — 觀主的信箱管家（獨立專案 66-butler，排程叫起來）
//
//   POST { "job": "triage" }  每兩小時：收件匣清零維持（tidy）→ 掃近 3 天沒看過的信 → 刪／自動歸檔／推歸檔卡
//   POST { "job": "tidy" }    一次性大掃除：tidy ＋ 收件匣裡所有沒看過的信（不限 3 天）都推歸檔卡
//   POST { "job": "news" }    立刻查一次航空城／客運園區的政府消息（平常跟週報一起，週一）
//   每輪 triage 結束時順便：09 點後推到期提醒；每月 1 號 09 點後出上個月的帳單月報
//   POST { "job": "weekly" }  每週一 09:03（台北）：到期清理（三月／五年標籤）＋信箱週報
//   （產品週報不在這裡，在產品專案的 weekly-report；/week 會去叫它）
//
// 鑑權：x-internal-secret = MAILBOT_CRON_SECRET（fail-closed）。只在這個專案用，不跟產品共用任何密碼。
// 所有推播只發給 ADMIN_TG_ID，經由私人管家 bot（ADMIN_BOT_TOKEN）。設定步驟：dev/MAIL-BUTLER.md
import { createClient } from "npm:@supabase/supabase-js@2";
import { gmailConfigured, listIds, getMeta, trash, labelIds, modify, fileAway, receivedAt, type MailMeta } from "../_shared/gmail.ts";
import {
  matchRule, decide, parseFrom, classifyPrompt, parseClassify, classifySys,
  fileText, fileButtons, fileOptions, digestText, mailWeeklyText, sweepFor, noThinking, LABELS, TODO,
  isSupport, taipeiDate,
  type Rule, type AiVerdict, type DigestItem, type MailWeek,
} from "../_shared/mailbot.ts";
import {
  SUPPORT_ADDRESS, recordReminder, sendDueReminders, handleSupport, recordCharges, sendMonthlyIfDue, sendNews,
} from "../_shared/extras.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// 發訊息用的是觀主私人的管家 bot（ADMIN_BOT_TOKEN），不是對外的卜卦 bot：
// 「要刪嗎」的按鈕按下去，回呼送到的是發出那則訊息的 bot——只有 admin-tg 接得住。
const TG = `https://api.telegram.org/bot${Deno.env.get("ADMIN_BOT_TOKEN")}`;
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";
const MODEL = Deno.env.get("MAILBOT_MODEL") ?? "claude-haiku-5-5";
// 掃描範圍：近 3 天。排程每兩小時一次，3 天是給「排程停了一兩天」的緩衝，不是要回頭掃整個信箱
const QUERY = Deno.env.get("MAILBOT_QUERY") ?? "in:inbox newer_than:3d";
const MAX_PER_RUN = Number(Deno.env.get("MAILBOT_MAX") ?? "60");
// 一輪最多推幾則「要刪嗎」：一次跳二十則等於沒人會看。多的留在待決清單，/mailask 叫出來
const MAX_ASK_PUSH = Number(Deno.env.get("MAILBOT_MAX_ASK") ?? "8");
const BATCH = 25;
// 到期清理一次最多丟幾封：清不完下週繼續，免得第一次跑撞上函式的時間上限
const SWEEP_MAX = Number(Deno.env.get("MAILBOT_SWEEP_MAX") ?? "300");

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
const say = (text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: ADMIN_TG_ID, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

/** 一批信丟給 Haiku 判。失敗回全 null——那幾封這輪不處理，下一輪再判。 */
async function classify(metas: MailMeta[], labels: string[], extra: string[]): Promise<(AiVerdict | null)[]> {
  const nt = noThinking(MODEL);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 160 * metas.length + 200 + nt.headroom,
        ...nt.body,
        system: [{ type: "text", text: classifySys(extra), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: classifyPrompt(metas, taipeiDate()) }],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      // 金鑰過期、被刪、額度用完：每一輪都會靜靜失敗，信全部卡在「AI 沒判出來」。這種要大聲說
      if (res.status === 401 || res.status === 403) {
        await say(`⚠️ 管家的 Anthropic 金鑰失效（${res.status}）：信件暫時無法分類，規則照常運作。\n` +
          `到 console.anthropic.com 開一把新的（到期選 Never），更新管家專案的 ANTHROPIC_API_KEY 即可，不必重新部署。`);
      }
      throw new Error(`anthropic ${res.status} ${body}`);
    }
    const data = await res.json();
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    // 用量只記 log：這個專案沒有產品的 ai_usage 表，也不該把私人用量混進產品成本
    console.log("mailbot usage", MODEL, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
    return parseClassify(text, metas.length, labels);
  } catch (e) {
    console.error("mailbot classify failed", e instanceof Error ? e.message : String(e));
    return metas.map(() => null);
  }
}

/** 現行可用的標籤：固定清單＋觀主在 TG 按出來的新分類。 */
async function loadLabels(): Promise<{ labels: string[]; extra: string[] }> {
  const { data } = await db.from("mailbot_labels").select("name");
  const extra = (data ?? []).map((r) => String(r.name)).filter((n) => !(LABELS as readonly string[]).includes(n));
  return { labels: [...LABELS, ...extra], extra };
}

const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

/** 收件匣清零的維持工作，每輪整理前先跑：
 *   ① 收件匣以外的未讀一律標已讀——左欄（標籤、分類）就不會掛數字
 *   ② 待辦一律回到收件匣
 *   ③ 收件匣裡已經有標籤（待辦除外）的＝已經有家了，歸檔、標已讀。觀主在 Gmail 自己貼標籤也算
 *   ④ 卡片還沒按、但信已經被他在 Gmail 處理掉（歸檔、貼標籤、刪了）的，卡片結案 */
async function tidy(lmap: Map<string, string>): Promise<{ read: number; archived: number; todoBack: number; closed: number }> {
  const out = { read: 0, archived: 0, todoBack: 0, closed: 0 };
  for (const id of await listIds("-in:inbox is:unread", 500)) {
    try { await modify(id, [], ["UNREAD"]); out.read++; } catch (e) { console.error("tidy read", id, errMsg(e)); }
  }
  if (lmap.get(TODO)) {
    for (const id of await listIds(`label:${TODO} -in:inbox`, 100)) {
      try { await modify(id, ["INBOX"], []); out.todoBack++; } catch (e) { console.error("tidy todo", id, errMsg(e)); }
    }
  }
  for (const id of await listIds(`in:inbox has:userlabels -label:${TODO}`, 200)) {
    try { await modify(id, [], ["INBOX", "UNREAD"]); out.archived++; } catch (e) { console.error("tidy archive", id, errMsg(e)); }
  }
  const { data: open } = await db.from("mailbot_seen").select("id, gmail_id").eq("status", "open").limit(50);
  for (const r of open ?? []) {
    let gone = false;
    try {
      const m = await getMeta(r.gmail_id);
      gone = !m.labels.includes("INBOX") || m.labels.some((l) => l.startsWith("Label_")) || m.labels.includes("TRASH");
    } catch { gone = true; }   // 404：信已經不在了
    if (gone) {
      await db.from("mailbot_seen").update({ status: "done", source: "user", decided_at: new Date().toISOString() }).eq("id", r.id);
      out.closed++;
    }
  }
  return out;
}

/** 一輪整理＋每天／每月的順手事。提醒與月報不管這輪有沒有新信都要檢查。 */
async function triage(query = QUERY, max = MAX_PER_RUN): Promise<Record<string, unknown>> {
  const out = await triageMail(query, max);
  if (out.ok === false) return out;
  try { out.reminders = await sendDueReminders(db, say); } catch (e) { console.error("reminders failed", errMsg(e)); }
  try { out.monthly = await sendMonthlyIfDue(db, say); } catch (e) { console.error("monthly failed", errMsg(e)); }
  return out;
}

// 這兩個分類的信、或 AI 說是扣款的，讀內文抓金額記帳
const CHARGE_LABELS = ["三月/帳單繳費", "三月/水電瓦斯", "三月/保險通知", "五年/產品營運"];

async function triageMail(query: string, max: number): Promise<Record<string, unknown>> {
  if (!gmailConfigured()) {
    await say("⚠️ 信箱管家還沒接上 Gmail：GMAIL_CLIENT_ID／GMAIL_CLIENT_SECRET／GMAIL_REFRESH_TOKEN 未設定。見 dev/MAIL-BUTLER.md");
    return { ok: false, error: "gmail not configured" };
  }
  const { data: rulesRaw } = await db.from("mailbot_rules").select("id, kind, pattern, action, label");
  const rules = (rulesRaw ?? []) as Rule[];
  const { labels, extra } = await loadLabels();
  // 標籤名 → id；讀不到（Gmail 掛了）就整輪不歸檔，信照樣分類與推卡
  let lmap = new Map<string, string>();
  try { lmap = await labelIds(); } catch (e) { console.error("labelIds failed", errMsg(e)); }

  let tidied: Awaited<ReturnType<typeof tidy>> | null = null;
  try { tidied = await tidy(lmap); } catch (e) { console.error("tidy failed", errMsg(e)); }

  const ids = await listIds(query, max);
  const { data: seen } = ids.length ? await db.from("mailbot_seen").select("gmail_id").in("gmail_id", ids) : { data: [] };
  const seenSet = new Set((seen ?? []).map((r) => r.gmail_id as string));
  const fresh = ids.filter((id) => !seenSet.has(id));
  if (!fresh.length) return { ok: true, scanned: ids.length, fresh: 0, tidied };

  const metas: MailMeta[] = [];
  for (let i = 0; i < fresh.length; i += 10) {
    const got = await Promise.allSettled(fresh.slice(i, i + 10).map(getMeta));
    for (const g of got) if (g.status === "fulfilled") metas.push(g.value);
      else console.error("getMeta failed", String(g.reason).slice(0, 200));
  }

  // 有規則的不必問 AI，省 token 也比較穩
  const ruled = new Map<string, Rule>();
  const needAi: MailMeta[] = [];
  for (const m of metas) {
    const r = matchRule(m, rules);
    if (r) ruled.set(m.id, r); else needAi.push(m);
  }
  const ai = new Map<string, AiVerdict | null>();
  for (let i = 0; i < needAi.length; i += BATCH) {
    const chunk = needAi.slice(i, i + BATCH);
    const vs = await classify(chunk, labels, extra);
    chunk.forEach((m, k) => ai.set(m.id, vs[k]));
  }

  const report: DigestItem[] = [];
  const trashedSenders = new Set<string>();
  const labeled: Record<string, number> = {};
  let trashed = 0, filed = 0, cards = 0, skipped = 0, pushed = 0;
  const ruleHits = new Map<number, number>();
  const now = () => new Date().toISOString();

  const chargeMetas: MailMeta[] = [];
  for (const m of metas) {
    const rule = ruled.get(m.id) ?? null;
    const v = ai.get(m.id) ?? null;
    // 客服來信：不管規則與 AI 怎麼說，一律推卡、絕不自動刪或歸檔
    const support = isSupport(m.to, SUPPORT_ADDRESS);
    const d = support ? { decision: "report" as const, source: "guard" as const, reason: "寄到客服信箱", label: v?.lb, autoFile: false }
      : decide(m, rule, v, labels);
    if (!d) { skipped++; continue; }
    const f = parseFrom(m.from);

    // 能直接處理的先處理；Gmail 那一步沒成功就不記，下一輪再試
    let auto = false;
    if (d.decision === "trash") {
      try { await trash(m.id); } catch (e) { console.error("trash failed", m.id, errMsg(e)); skipped++; continue; }
    } else if (d.autoFile && d.label && lmap.get(d.label)) {
      try { await fileAway(m.id, lmap.get(d.label)!); auto = true; }
      catch (e) { console.error("fileAway failed", m.id, errMsg(e)); }   // 歸檔失敗就退回成卡片
    }
    const card = d.decision !== "trash" && !auto;
    const SUPPORT_LABEL = "五年/客服往來";
    const options = !card ? null : support
      ? [...(labels.includes(SUPPORT_LABEL) ? [SUPPORT_LABEL] : []), ...fileOptions(d.label, v)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 3)
      : fileOptions(d.label, v);
    const suggest = !card ? null : support && !labels.includes(SUPPORT_LABEL) ? SUPPORT_LABEL : (v?.nw ?? null);
    const sup = card && support ? await handleSupport(m) : null;

    const row = {
      gmail_id: m.id, thread_id: m.threadId, sender: f.email, sender_name: f.name.slice(0, 120),
      subject: m.subject.slice(0, 300), snippet: m.snippet.slice(0, 400), received_at: m.receivedAt,
      decision: d.decision, source: d.source, reason: (d.reason || "").slice(0, 120),
      status: card ? "open" : "done", decided_at: card ? null : now(),
      label: auto ? d.label : null, options, suggest, summary: (sup?.sum || v?.sum || "").slice(0, 120) || null,
    };
    const { data: ins, error } = await db.from("mailbot_seen")
      .upsert(row, { onConflict: "gmail_id", ignoreDuplicates: true }).select("id").maybeSingle();
    if (error) { console.error("mailbot_seen insert", error.message); continue; }
    if (!ins) continue;   // 同時有另一輪在跑、已經記過了
    if (rule) ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);

    if (d.decision === "trash") { trashed++; trashedSenders.add(f.name.slice(0, 16)); continue; }
    try { await recordReminder(db, m, v); } catch (e) { console.error("recordReminder", errMsg(e)); }
    if (!support && (v?.chg || (d.label && CHARGE_LABELS.includes(d.label)))) chargeMetas.push(m);
    if (auto) {
      filed++; labeled[d.label!] = (labeled[d.label!] ?? 0) + 1;
      if (d.decision === "report") report.push({ from: m.from, subject: m.subject, sum: v?.sum ?? "" });
      continue;
    }
    cards++;
    if (pushed < MAX_ASK_PUSH) {
      pushed++;
      await say((sup ? sup.head + "\n\n" : "") +
        fileText({ from: m.from, subject: m.subject, snippet: m.snippet, reason: d.reason, sum: sup?.sum || v?.sum, ask: d.decision === "ask" }, options!, suggest),
        { reply_markup: { inline_keyboard: fileButtons(ins.id as number, options!, suggest) } });
    }
  }

  let charges = 0;
  try { charges = await recordCharges(db, chargeMetas); } catch (e) { console.error("recordCharges", errMsg(e)); }

  for (const [id, n] of ruleHits) {
    const { data: r } = await db.from("mailbot_rules").select("hits").eq("id", id).maybeSingle();
    await db.from("mailbot_rules").update({ hits: Number(r?.hits ?? 0) + n, last_hit_at: now() }).eq("id", id);
  }

  const text = digestText(report, { trashed, kept: filed, asked: cards, skipped, trashedSenders: [...trashedSenders], labeled });
  if (text) await say(cards > pushed ? `${text}\n<i>還有 ${cards - pushed} 張卡沒推，打 /mailask</i>` : text);
  return { ok: true, scanned: ids.length, fresh: metas.length, trashed, filed, cards, skipped, charges, tidied };
}

/** 到期清理：三月層 3 個月、五年層 5 年。丟垃圾桶（30 天內撿得回來），不是永久刪。 */
async function sweep(): Promise<NonNullable<MailWeek["sweep"]>> {
  const byLabel: Record<string, number> = {};
  let swept = 0;
  const { labels } = await loadLabels();
  for (const s of sweepFor(labels)) {
    if (swept >= SWEEP_MAX) break;
    const ids = await listIds(s.q, SWEEP_MAX - swept);
    for (const id of ids) {
      try { await trash(id); swept++; byLabel[s.label] = (byLabel[s.label] ?? 0) + 1; }
      catch (e) { console.error("sweep trash failed", id, e instanceof Error ? e.message : String(e)); }
    }
  }
  const todo = await listIds("label:待辦", 500);
  // 列表是新到舊，最後一封就是最舊的
  const oldest = todo.length ? await receivedAt(todo[todo.length - 1]).catch(() => null) : null;
  return { swept, byLabel, todo: todo.length, todoOldestDays: oldest ? Math.floor((Date.now() - oldest) / 86_400_000) : null };
}

async function weekly(): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  // deno-lint-ignore no-explicit-any
  const count = async (f: (q: any) => any) => {
    const { count } = await f(db.from("mailbot_seen").select("id", { count: "exact", head: true }));
    return count ?? 0;
  };
  const w: MailWeek = {
    trashed: await count((q) => q.eq("decision", "trash").gte("created_at", since)),
    filed: await count((q) => q.neq("decision", "trash").eq("status", "done").not("label", "is", null).gte("created_at", since)),
    cards: await count((q) => q.not("options", "is", null).gte("created_at", since)),
    open: await count((q) => q.eq("status", "open")),
    rules: (await db.from("mailbot_rules").select("id", { count: "exact", head: true })).count ?? 0,
    newLabels: ((await db.from("mailbot_labels").select("name").gte("created_at", since)).data ?? []).map((r) => String(r.name)),
  };
  // 清理失敗不擋週報：週報是給人看的，清理下週還會再跑
  if (gmailConfigured()) {
    try { w.sweep = await sweep(); }
    catch (e) { console.error("sweep failed", e instanceof Error ? e.message : String(e)); }
  }
  await say(mailWeeklyText(w));
  // 政府消息跟週報一起發；查不到不影響週報
  let news = 0;
  try { news = await sendNews(db, say); }
  catch (e) { console.error("news failed", errMsg(e)); await say(`⚠️ 航空城消息這週沒查成：${errMsg(e).slice(0, 150).replace(/</g, "&lt;")}`); }
  return { ok: true, swept: w.sweep?.swept ?? 0, news };
}

Deno.serve(async (req) => {
  if (!Deno.env.get("ADMIN_BOT_TOKEN")) {
    console.error("ADMIN_BOT_TOKEN 未設定：管家沒有 bot 可以發訊息");
    return Response.json({ ok: false, error: "ADMIN_BOT_TOKEN not set" }, { status: 500 });
  }
  const secret = Deno.env.get("MAILBOT_CRON_SECRET");
  if (!secret || req.headers.get("x-internal-secret") !== secret) {
    if (!secret) console.error("MAILBOT_CRON_SECRET 未設定：mail-butler 一律拒絕");
    return new Response("forbidden", { status: 403 });
  }
  let job = "";
  try { job = String((await req.json())?.job ?? ""); } catch { /* 空 body */ }
  try {
    const out = job === "weekly" ? await weekly()
      : job === "triage" ? await triage()
      : job === "tidy" ? await triage(`in:inbox -label:${TODO}`, 100)
      : job === "news" ? { ok: true, news: await sendNews(db, say) }
      : { ok: false, error: "unknown job" };
    return Response.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("MAILBOT_ERROR", e instanceof Error ? e.stack ?? msg : msg);
    // token 失效之類的錯不推就沒人知道——排程每兩小時默默失敗，信箱照樣塞滿
    await say(`⚠️ 信箱管家（${job}）出錯：${msg.slice(0, 300).replace(/</g, "&lt;")}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
