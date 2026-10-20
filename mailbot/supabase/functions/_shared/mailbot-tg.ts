// _shared/mailbot-tg.ts — 信箱管家的 TG 指令與按鈕（由 admin-tg，觀主私人的管家 bot 呼叫）
//
//   /mail_help         說明
//   /mailnow           立刻整理一輪（不等排程）
//   /mailtidy          大掃除：收件匣裡所有還沒歸檔的信都推卡片（不限 3 天）
//   /mailask           把還沒按的歸檔卡再推一次
//   /maillog           最近自動刪掉的 10 封，附「救回」鈕
//   /mailrules         列出規則
//   /mailrule del N    刪第 N 條規則
//   /mailrule add 動作 種類 內容   例：/mailrule add trash domain shopee.tw
//   /week              立刻出一份產品週報
//   （一般句子）        用說的改規則，例：「以後蝦皮的信都刪掉」→ 確認卡 → 按 ✅ 才生效
//
// 呼叫端（admin-tg，觀主私人的管家 bot）已確認是觀主才進來；這裡不再驗身分。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { trash, untrash, modify, fileAway, ensureLabel, labelIds } from "./gmail.ts";
import {
  esc, fileText, fileButtons, parseMbCallback, mbCallback, isValidNewLabel, TODO, LABELS, noThinking,
  ruleNlSys, ruleNlPrompt, parseRuleIntent, describeOp,
  KIND_LABEL, ACTION_LABEL, type Rule, type RuleOp,
} from "./mailbot.ts";

type Send = (text: string, extra?: Record<string, unknown>) => Promise<unknown>;

export const MAILBOT_HELP =
  "<b>📬 信箱管家</b>\n\n" +
  "收件匣清零：收件匣只放待辦和你還沒處理的信，其他的歸檔、標已讀。\n" +
  "每兩小時整理一輪：廣告丟垃圾桶、有把握的自動歸檔、其餘推一張卡給你選放哪（⭐是推薦）。\n" +
  "你按的每個「以後都…」都會變成一條規則，下次就不問了。\n\n" +
  "<code>/mailnow</code>　立刻整理一輪\n" +
  "<code>/mailtidy</code>　大掃除：收件匣裡全部推卡\n" +
  "<code>/mailask</code>　還沒按的卡再推一次\n" +
  "<code>/maillog</code>　最近自動刪的信（可救回）\n" +
  "<code>/mailrules</code>　看規則\n" +
  "<code>/mailrule del 編號</code>　刪規則\n" +
  "<code>/mailrule add trash|report|keep sender|domain|subject 內容</code>\n" +
  "<code>/week</code>　立刻出產品週報（從產品專案送來）\n\n" +
  "💬 <b>也可以直接用說的改規則</b>，例如：\n" +
  "「以後蝦皮的信都刪掉」「Anthropic 的收據放五年/產品營運」「104 的信不要再刪了」\n" +
  "我會先回一張確認卡，按 ✅ 才生效。";

const MAILBOT_CMD = /^\/(mail_help|mailnow|mailtidy|mailask|maillog|mailrules|mailrule|week)(@\w+)?(\s|$)/;
export const isMailbotCommand = (text: string) => MAILBOT_CMD.test(text);

// 產品週報在產品專案（CangWang-backend 的 weekly-report），由它自己讀產品數據、經管家 bot 送過來。
// 這裡只負責叫它：帶 REPORT_SECRET，兩個專案各存一份同樣的值。
const PRODUCT_REPORT_URL = Deno.env.get("PRODUCT_REPORT_URL") ?? "https://ajogafvzlhqwlxwkfcpn.supabase.co/functions/v1/weekly-report";

async function fireJob(job: "triage" | "weekly" | "tidy") {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/mail-butler`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": Deno.env.get("MAILBOT_CRON_SECRET") ?? "" },
    body: JSON.stringify({ job }),
  });
  return res.json().catch(() => ({ ok: res.ok }));
}

export async function handleMailbotCommand(db: SupabaseClient, text: string, send: Send): Promise<void> {
  const cmd = text.match(MAILBOT_CMD)?.[1] ?? "";
  const arg = text.replace(MAILBOT_CMD, "").trim();

  if (cmd === "mail_help") { await send(MAILBOT_HELP); return; }

  if (cmd === "week") {
    const res = await fetch(PRODUCT_REPORT_URL, { method: "POST", headers: { "x-report-secret": Deno.env.get("REPORT_SECRET") ?? "" } })
      .catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    // 成功時週報由產品那邊直接送來，這裡不必再說話
    if (!res.ok) await send(`叫不到產品週報（${res.status}）：${esc((await res.text()).slice(0, 150))}\n<i>檢查兩個專案的 REPORT_SECRET 是否一致</i>`);
    return;
  }

  if (cmd === "mailnow") {
    await send("📬 整理中…");
    const r = await fireJob("triage") as Record<string, unknown>;
    if (!r?.ok) { await send(`整理失敗：${esc(String(r?.error ?? "unknown"))}`); return; }
    if (!r.fresh) await send(`沒有新信（近 3 天收件匣 ${r.scanned ?? 0} 封都看過了）。`);
    return;
  }

  if (cmd === "mailtidy") {
    await send("🧹 大掃除中…（收件匣裡沒歸檔的信會一張一張推卡過來）");
    const r = await fireJob("tidy") as Record<string, unknown>;
    if (!r?.ok) { await send(`大掃除失敗：${esc(String(r?.error ?? "unknown"))}`); return; }
    const t = (r.tidied ?? {}) as Record<string, number>;
    await send(`🧹 完成：標已讀 ${t.read ?? 0}、已有標籤的歸檔 ${t.archived ?? 0}、待辦拉回收件匣 ${t.todoBack ?? 0}、` +
      `新推卡片 ${r.cards ?? 0}、自動歸檔 ${r.filed ?? 0}、刪 ${r.trashed ?? 0}`);
    return;
  }

  if (cmd === "mailask") {
    const { data } = await db.from("mailbot_seen")
      .select("id, sender, sender_name, subject, snippet, reason, decision, options, suggest, summary")
      .eq("status", "open").order("created_at", { ascending: true }).limit(10);
    if (!data?.length) { await send("沒有待歸檔的信，收件匣只剩待辦。"); return; }
    for (const r of data) {
      const options = (r.options ?? []) as string[];
      await send(fileText({ from: `${r.sender_name} <${r.sender}>`, subject: r.subject ?? "", snippet: r.snippet ?? "",
        reason: r.reason ?? "", sum: r.summary ?? undefined, ask: r.decision === "ask" }, options, r.suggest),
        { reply_markup: { inline_keyboard: fileButtons(r.id, options, r.suggest) } });
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
    const { data } = await db.from("mailbot_rules").select("id, kind, pattern, action, hits, label")
      .order("action").order("hits", { ascending: false }).limit(80);
    if (!data?.length) { await send("還沒有規則。從「要刪嗎」那幾顆按鈕按出來，或 /mailrule add。"); return; }
    const lines = (data as (Rule & { hits: number })[]).map((r) =>
      `#${r.id} ${ACTION_LABEL[r.action]}　${KIND_LABEL[r.kind]} <code>${esc(r.pattern)}</code>${r.label ? `　🏷${esc(r.label)}` : ""}　命中 ${r.hits}`);
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

const NL_MODEL = Deno.env.get("MAILBOT_RULE_MODEL") ?? Deno.env.get("MAILBOT_MODEL") ?? "claude-haiku-5-5";

type RuleRow = Pick<Rule, "id" | "kind" | "pattern" | "action" | "label">;

/** 一般句子 → 規則草稿 → 確認卡。模型只翻譯，真正寫進規則要等觀主按 ✅。 */
export async function handleMailbotFreeText(db: SupabaseClient, text: string, send: Send): Promise<void> {
  const { data: rulesRaw } = await db.from("mailbot_rules").select("id, kind, pattern, action, label").order("id");
  const rules = (rulesRaw ?? []) as RuleRow[];
  const { data: extra } = await db.from("mailbot_labels").select("name");
  const labels = [...LABELS, ...(extra ?? []).map((r) => String(r.name))];

  const nt = noThinking(NL_MODEL);
  let reply = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: NL_MODEL, max_tokens: 600 + nt.headroom, ...nt.body,
        system: [{ type: "text", text: ruleNlSys(labels), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: ruleNlPrompt(text, rules) }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    reply = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  } catch (e) {
    await send(`我現在聽不懂句子（${esc(e instanceof Error ? e.message : String(e))}）。可以先用 <code>/mailrule add</code>，打 /mail_help 看格式。`);
    return;
  }

  const intent = parseRuleIntent(reply, labels, new Set(rules.map((r) => r.id)));
  if (!intent.ops.length) {
    await send(intent.say ? `🤔 ${esc(intent.say)}` : "這句我沒辦法變成規則。可以換個說法，例如「以後蝦皮的信都刪掉」；打 /mail_help 看指令。");
    return;
  }
  const { data: draft, error } = await db.from("mailbot_rule_drafts")
    .insert({ text: text.slice(0, 500), ops: intent.ops, new_labels: intent.newLabels }).select("id").single();
  if (error || !draft) { await send(`存不了草稿：${esc(error?.message ?? "")}`); return; }
  await send(
    `📏 <b>要這樣改規則嗎？</b>\n\n${intent.ops.map((o) => describeOp(o, rules)).join("\n")}` +
    (intent.newLabels.length ? `\n\n🆕 會在 Gmail 新開分類：${intent.newLabels.map(esc).join("、")}` : "") +
    (intent.say ? `\n\n<i>${esc(intent.say)}</i>` : "") +
    `\n\n<i>生效後從下一輪整理開始套用；已經在收件匣的信不受影響。</i>`,
    { reply_markup: { inline_keyboard: [[
      { text: "✅ 好", callback_data: mbCallback("Y", draft.id) },
      { text: "✖ 不要", callback_data: mbCallback("N", draft.id) },
    ]] } });
}

/** 按 ✅：照草稿寫進規則。草稿 24 小時內有效，按過就失效，按兩次不會寫兩次。 */
async function applyDraft(db: SupabaseClient, id: number, yes: boolean, send: Send, clearButtons: () => Promise<unknown>) {
  const { data: d } = await db.from("mailbot_rule_drafts").select("id, ops, new_labels, status, created_at").eq("id", id).maybeSingle();
  await clearButtons();
  if (!d || d.status !== "open") { await send("這張確認卡已經處理過了。"); return; }
  if (Date.now() - new Date(d.created_at).getTime() > 86_400_000) { await send("這張確認卡超過一天，作廢了。再說一次就好。"); return; }
  if (!yes) {
    await db.from("mailbot_rule_drafts").update({ status: "cancelled" }).eq("id", id);
    await send("✖ 已取消，規則沒有變。");
    return;
  }
  const done: string[] = [];
  try {
    if ((d.new_labels ?? []).length) {
      const lmap = await labelIds();
      for (const name of d.new_labels as string[]) {
        await ensureLabel(name, lmap);
        await db.from("mailbot_labels").upsert({ name, note: "TG 用說的新開" }, { onConflict: "name" });
      }
    }
    for (const op of d.ops as RuleOp[]) {
      if (op.op === "del") {
        const { data } = await db.from("mailbot_rules").delete().eq("id", op.id).select("id");
        done.push(data?.length ? `➖ 刪了 #${op.id}` : `➖ #${op.id} 已經不在了`);
      } else {
        const { data: r, error } = await db.from("mailbot_rules")
          .upsert({ kind: op.kind, pattern: op.pattern, action: op.action, label: op.label ?? null, note: "TG 用說的" }, { onConflict: "kind,pattern" })
          .select("id").single();
        done.push(error ? `⚠️ ${esc(op.pattern)} 寫不進去：${esc(error.message)}` : `➕ #${r.id} ${describeOp(op).replace(/^➕ /, "")}`);
      }
    }
  } catch (e) {
    await send(`改到一半出錯：${esc(e instanceof Error ? e.message : String(e))}\n已完成的：\n${done.join("\n") || "（無）"}`);
    return;
  }
  await db.from("mailbot_rule_drafts").update({ status: "applied" }).eq("id", id);
  await send(`✅ 規則已更新\n\n${done.join("\n")}\n\n<i>/mailrules 看全部</i>`);
}

/** 按鈕：mb:<op>:<id>。回 false＝不是信箱管家的按鈕。 */
export async function handleMailbotCallback(
  db: SupabaseClient, data: string, send: Send, clearButtons: () => Promise<unknown>,
): Promise<boolean> {
  const cb = parseMbCallback(data);
  if (!cb) return false;
  if (cb.op === "Y" || cb.op === "N") { await applyDraft(db, cb.id, cb.op === "Y", send, clearButtons); return true; }
  const { data: row } = await db.from("mailbot_seen")
    .select("id, gmail_id, sender, sender_name, subject, status, decision, options, suggest, label").eq("id", cb.id).maybeSingle();
  if (!row) { await send("找不到這封信的紀錄。"); return true; }
  const now = new Date().toISOString();
  const domain = String(row.sender ?? "").split("@").pop() ?? "";
  const subj = esc(String(row.subject ?? "").slice(0, 60));

  if (cb.op === "u") {
    try { await untrash(row.gmail_id); } catch (e) { await send(`救不回來：${esc(String(e).slice(0, 150))}`); return true; }
    await db.from("mailbot_seen").update({ decision: "keep", source: "user", status: "open", decided_at: null }).eq("id", row.id);
    await db.from("mailbot_rules").upsert({ kind: "sender", pattern: row.sender, action: "keep", note: "從 /maillog 救回" }, { onConflict: "kind,pattern" });
    await send(`♻ 已救回「${subj}」，回到收件匣；並記下 <code>${esc(row.sender)}</code> 以後不刪。要放哪，打 /mailask 會推卡片。`);
    return true;
  }

  // 「以後都放這」：剛剛歸檔到哪，就讓這個寄件人以後都自動放進去
  if (cb.op === "A") {
    if (!row.label) { await send("這封還沒歸檔，沒有可以記的地方。"); return true; }
    const { data: r } = await db.from("mailbot_rules")
      .upsert({ kind: "sender", pattern: row.sender, action: "keep", label: row.label, note: "TG 歸檔卡" }, { onConflict: "kind,pattern" })
      .select("id").single();
    await clearButtons();
    // 同一個寄件人還在等歸檔的，照新規則一起放好
    const { data: same } = await db.from("mailbot_seen").select("id, gmail_id").eq("status", "open").eq("sender", row.sender).limit(50);
    let n = 0;
    if (same?.length) {
      const lid = await ensureLabel(row.label);
      for (const s2 of same) {
        try { await fileAway(s2.gmail_id, lid); } catch { continue; }
        await db.from("mailbot_seen").update({ decision: "keep", source: "rule", status: "done", label: row.label, decided_at: now }).eq("id", s2.id);
        n++;
      }
    }
    await send(`📏 規則 #${r?.id ?? "?"}：<code>${esc(row.sender)}</code> 以後自動放「${esc(row.label)}」` + (n ? `\n（等歸檔的同寄件人 ${n} 封也一起放好了）` : ""));
    return true;
  }

  if (row.status !== "open") { await clearButtons(); await send("這封已經處理過了。"); return true; }

  // 歸檔：卡上的選項、或新分類
  if (cb.op === "o0" || cb.op === "o1" || cb.op === "o2" || cb.op === "n") {
    const label = cb.op === "n" ? row.suggest : ((row.options ?? []) as string[])[Number(cb.op.slice(1))];
    if (!label) { await send("這顆按鈕沒有對應的分類了，打 /mailask 重推卡片。"); return true; }
    if (cb.op === "n" && !isValidNewLabel(label)) { await send(`「${esc(label)}」不是合法的分類名稱。`); return true; }
    let lid: string;
    try { lid = await ensureLabel(label, await labelIds()); await fileAway(row.gmail_id, lid); }
    catch (e) { await send(`歸檔失敗：${esc(String(e).slice(0, 150))}`); return true; }
    if (cb.op === "n") await db.from("mailbot_labels").upsert({ name: label, note: "TG 歸檔卡新開" }, { onConflict: "name" });
    await db.from("mailbot_seen").update({ decision: "keep", source: "user", status: "done", label, decided_at: now }).eq("id", row.id);
    await clearButtons();
    await send(`🗂 已放進「${esc(label)}」：${subj}` + (cb.op === "n" ? `\n🆕 新分類已建立，之後 AI 也會用它` : ""),
      { reply_markup: { inline_keyboard: [[{ text: `📏 ${String(row.sender_name ?? row.sender).slice(0, 16)} 以後都放這`, callback_data: mbCallback("A", row.id) }]] } });
    return true;
  }

  // 待辦：貼待辦、標已讀（左欄不掛數字）、留在收件匣
  if (cb.op === "p") {
    try { const lid = await ensureLabel(TODO); await modify(row.gmail_id, [lid, "INBOX"], ["UNREAD"]); }
    catch (e) { await send(`標不上待辦：${esc(String(e).slice(0, 150))}`); return true; }
    await db.from("mailbot_seen").update({ decision: "keep", source: "user", status: "done", label: TODO, decided_at: now }).eq("id", row.id);
    await clearButtons();
    await send(`📌 已列入待辦（留在收件匣）：${subj}\n<i>處理完在 Gmail 把「待辦」標籤拿掉、換成該放的分類，下一輪就會自動歸檔。</i>`);
    return true;
  }

  // 刪（t／T／D），以及舊版卡片的 k／K
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
    if (rule.action === "trash") {
      // 同一個寄件人／網域還在等歸檔的，一併刪掉，不必再一張一張按
      let q = db.from("mailbot_seen").select("id, gmail_id").eq("status", "open").neq("id", row.id);
      q = rule.kind === "domain" ? q.or(`sender.like.%@${domain},sender.like.%.${domain}`) : q.eq("sender", row.sender);
      const { data: same } = await q.limit(50);
      let n = 0;
      for (const s2 of same ?? []) {
        try { await trash(s2.gmail_id); } catch { continue; }
        await db.from("mailbot_seen").update({ decision: "trash", source: "rule", status: "done", decided_at: now }).eq("id", s2.id);
        n++;
      }
      if (n) extra += `\n（等歸檔的同來源 ${n} 封也一併刪了）`;
    }
  }
  const what = isTrash ? "🗑 已刪" : cb.op === "K" ? "📌 已留" : "📥 已留";
  await send(`${what}：${subj}${extra}`);
  return true;
}
