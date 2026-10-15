// functions/mail-butler/index.ts — 觀主的信箱管家＋產品週報（排程叫起來）
//
//   POST { "job": "triage" }  每兩小時：掃收件匣近 3 天沒看過的信 → 規則／AI 分類 → 刪、報、問
//   POST { "job": "weekly" }  每週一 09:00（台北）：產品週報
//
// 鑑權與 due-reminder 同一把：x-internal-secret = BROADCAST_INTERNAL_SECRET（fail-closed）。
// 所有推播只發給 ADMIN_TG_ID。設定步驟：dev/MAIL-BUTLER.md
import { createClient } from "npm:@supabase/supabase-js@2";
import { gmailConfigured, listIds, getMeta, trash, type MailMeta } from "../_shared/gmail.ts";
import {
  matchRule, decide, parseFrom, classifyPrompt, parseClassify, CLASSIFY_SYS,
  askText, askButtons, digestText, weeklyText,
  type Rule, type AiVerdict, type DigestItem, type WeeklyStats,
} from "../_shared/mailbot.ts";
import { logUsage } from "../_shared/services.ts";
import { noThinking } from "../_shared/model-params.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TG = `https://api.telegram.org/bot${Deno.env.get("TG_BOT_TOKEN")}`;
const ADMIN_TG_ID = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";
const MODEL = Deno.env.get("MAILBOT_MODEL") ?? "claude-haiku-5-5";
// 掃描範圍：近 3 天。排程每兩小時一次，3 天是給「排程停了一兩天」的緩衝，不是要回頭掃整個信箱
const QUERY = Deno.env.get("MAILBOT_QUERY") ?? "in:inbox newer_than:3d";
const MAX_PER_RUN = Number(Deno.env.get("MAILBOT_MAX") ?? "60");
// 一輪最多推幾則「要刪嗎」：一次跳二十則等於沒人會看。多的留在待決清單，/mailask 叫出來
const MAX_ASK_PUSH = Number(Deno.env.get("MAILBOT_MAX_ASK") ?? "8");
const BATCH = 25;

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
async function classify(metas: MailMeta[]): Promise<(AiVerdict | null)[]> {
  const nt = noThinking(MODEL);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120 * metas.length + 200 + nt.headroom,
        ...nt.body,
        system: [{ type: "text", text: CLASSIFY_SYS, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: classifyPrompt(metas) }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    await logUsage(db, {
      userId: null, mode: "mailbot", model: MODEL, estimated: !data.usage,
      usage: {
        in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0,
        cacheWrite: data.usage?.cache_creation_input_tokens ?? 0, cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      },
    });
    return parseClassify(text, metas.length);
  } catch (e) {
    console.error("mailbot classify failed", e instanceof Error ? e.message : String(e));
    return metas.map(() => null);
  }
}

async function triage(): Promise<Record<string, unknown>> {
  if (!gmailConfigured()) {
    await say("⚠️ 信箱管家還沒接上 Gmail：GMAIL_CLIENT_ID／GMAIL_CLIENT_SECRET／GMAIL_REFRESH_TOKEN 未設定。見 dev/MAIL-BUTLER.md");
    return { ok: false, error: "gmail not configured" };
  }
  const { data: rulesRaw } = await db.from("mailbot_rules").select("id, kind, pattern, action");
  const rules = (rulesRaw ?? []) as Rule[];

  const ids = await listIds(QUERY, MAX_PER_RUN);
  if (!ids.length) return { ok: true, scanned: 0 };
  const { data: seen } = await db.from("mailbot_seen").select("gmail_id").in("gmail_id", ids);
  const seenSet = new Set((seen ?? []).map((r) => r.gmail_id as string));
  const fresh = ids.filter((id) => !seenSet.has(id));
  if (!fresh.length) return { ok: true, scanned: ids.length, fresh: 0 };

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
    const vs = await classify(chunk);
    chunk.forEach((m, k) => ai.set(m.id, vs[k]));
  }

  const report: DigestItem[] = [];
  const trashedSenders = new Set<string>();
  let trashed = 0, kept = 0, asked = 0, skipped = 0, pushed = 0;
  const ruleHits = new Map<number, number>();

  for (const m of metas) {
    const rule = ruled.get(m.id) ?? null;
    const v = ai.get(m.id) ?? null;
    const d = decide(m, rule, v);
    if (!d) { skipped++; continue; }
    const f = parseFrom(m.from);

    if (d.decision === "trash") {
      try { await trash(m.id); } catch (e) {
        console.error("trash failed", m.id, e instanceof Error ? e.message : String(e));
        skipped++; continue;   // 沒刪成就不記，下一輪再試
      }
    }
    const row = {
      gmail_id: m.id, thread_id: m.threadId, sender: f.email, sender_name: f.name.slice(0, 120),
      subject: m.subject.slice(0, 300), snippet: m.snippet.slice(0, 400), received_at: m.receivedAt,
      decision: d.decision, source: d.source, reason: (d.reason || "").slice(0, 120),
      status: d.decision === "ask" ? "open" : "done",
      decided_at: d.decision === "ask" ? null : new Date().toISOString(),
    };
    const { data: ins, error } = await db.from("mailbot_seen")
      .upsert(row, { onConflict: "gmail_id", ignoreDuplicates: true }).select("id").maybeSingle();
    if (error) { console.error("mailbot_seen insert", error.message); continue; }
    if (!ins) continue;   // 同時有另一輪在跑、已經記過了
    if (rule) ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);

    if (d.decision === "trash") { trashed++; trashedSenders.add(f.name.slice(0, 16)); }
    else if (d.decision === "keep") kept++;
    else if (d.decision === "report") report.push({ from: m.from, subject: m.subject, sum: v?.sum ?? "" });
    else {
      asked++;
      if (pushed < MAX_ASK_PUSH) {
        pushed++;
        await say(askText({ from: m.from, subject: m.subject, snippet: m.snippet, reason: d.reason }),
          { reply_markup: { inline_keyboard: askButtons(ins.id as number) } });
      }
    }
  }

  for (const [id, n] of ruleHits) {
    const { data: r } = await db.from("mailbot_rules").select("hits").eq("id", id).maybeSingle();
    await db.from("mailbot_rules").update({ hits: Number(r?.hits ?? 0) + n, last_hit_at: new Date().toISOString() }).eq("id", id);
  }

  const text = digestText(report, { trashed, kept, asked, skipped, trashedSenders: [...trashedSenders] });
  if (text) await say(asked > pushed ? `${text}\n<i>還有 ${asked - pushed} 封待決沒推，打 /mailask</i>` : text);
  return { ok: true, scanned: ids.length, fresh: metas.length, trashed, kept, reported: report.length, asked, skipped };
}

async function weekly(): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc("admin_weekly_stats");
  if (error || !data) {
    await say(`⚠️ 週報算不出來：${(error?.message ?? "no data").slice(0, 200)}`);
    return { ok: false, error: error?.message };
  }
  await say(weeklyText(data as WeeklyStats));
  return { ok: true };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("BROADCAST_INTERNAL_SECRET");
  if (!secret || req.headers.get("x-internal-secret") !== secret) {
    if (!secret) console.error("BROADCAST_INTERNAL_SECRET 未設定：mail-butler 一律拒絕");
    return new Response("forbidden", { status: 403 });
  }
  let job = "";
  try { job = String((await req.json())?.job ?? ""); } catch { /* 空 body */ }
  try {
    const out = job === "weekly" ? await weekly() : job === "triage" ? await triage() : { ok: false, error: "unknown job" };
    return Response.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("MAILBOT_ERROR", e instanceof Error ? e.stack ?? msg : msg);
    // token 失效之類的錯不推就沒人知道——排程每兩小時默默失敗，信箱照樣塞滿
    await say(`⚠️ 信箱管家（${job}）出錯：${msg.slice(0, 300).replace(/</g, "&lt;")}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
