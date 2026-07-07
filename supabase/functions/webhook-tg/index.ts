// webhook-tg/index.ts — Telegram adapter
// 流程：/start 入觀 → 選角 → 輸入問事 → [擲卦] → 盤面＋解卦 → 建議追問按鈕 / 手動追問
import { createClient } from "npm:@supabase/supabase-js@2";
import { renderChartTG, mdToTG } from "../_shared/services.ts";
import { ALL_GUA_NAMES } from "../_shared/core.ts";
import { castAndInterpret, followupInterpret, deepenCast, commentCast } from "../_shared/pipeline.ts";
import { GRANT_REGISTER, FREE_CASTS_PER_DAY, FREE_FOLLOWUPS_PER_CAST, COST_FOLLOWUP, COST_EXTRA_CAST, COST_DEEPEN, COST_COMMENT } from "../_shared/services.ts";
import { CASTING_LINE } from "../_shared/rules.ts";
import { tryHandleBroadcast } from "../_shared/broadcast-command.ts";
import { chat, FAVOR_CAP } from "../_shared/chat.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TG = `https://api.telegram.org/bot${Deno.env.get("TG_BOT_TOKEN")}`;

// 查今日已用免費卦數（回傳已用次數；用 free_quota，key 同 billCast）
async function usedCastsToday(tgId: string): Promise<number> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const { data: q } = await db.from("free_quota").select("used_today, last_reset").eq("key", `tg:${tgId}`).maybeSingle();
  return (q && q.last_reset === today) ? q.used_today : 0;
}
// 起卦按鈕標價文字
async function castPriceTag(tgId: string): Promise<string> {
  const used = await usedCastsToday(tgId);
  const left = FREE_CASTS_PER_DAY - used;
  return left > 0 ? `免費剩${left}卦` : `耗${COST_EXTRA_CAST}靈石`;
}
// 某卦的追問按鈕標價文字
async function followupPriceTag(castId: string): Promise<string> {
  const { data: c } = await db.from("casts").select("followup_used").eq("id", castId).maybeSingle();
  const used = c?.followup_used ?? 0;
  return used < FREE_FOLLOWUPS_PER_CAST ? "靈石0" : `靈石${COST_FOLLOWUP}`;
}

/* ---------- TG helpers ---------- */
async function tg(method: string, payload: Record<string, unknown>) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!r.ok) console.error(method, await r.text());
  return r;
}
// Telegram HTML 不支援 <details>/<summary>，若模型誤吐會整段裸露——送出前剝掉標籤（保留內文），並收掉多餘空行
const stripUnsupportedTags = (s: string) =>
  s.replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
const send = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chatId, text: stripUnsupportedTags(text), parse_mode: "HTML", ...extra });
const typing = (chatId: number) => tg("sendChatAction", { chat_id: chatId, action: "typing" });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CHAR_LABELS: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀貓" };

const DISCLAIMER =
  "<b>幾知觀 · 修行須知</b>\n\n" +
  "本服務以《易》之六爻為本，為<b>傳統文化體驗與娛樂</b>，旨在提供反思與啟發的視角，<b>非科學預測，亦非任何專業意見</b>。\n\n" +
  "・<b>財運投資</b>：所有內容皆為文化占卜，非投資建議；本服務不具證券投資顧問資格，不對任何買賣決策負責。\n" +
  "・<b>感情人際</b>：卦象僅供自省參考，重要關係決定請與當事人坦誠溝通。\n" +
  "・<b>健康疾病</b>：如有身心不適，請務必就醫；占卜不能取代專業醫療。\n" +
  "・<b>重大抉擇</b>：吉凶供參，決策在己——你才是自己人生的主人。\n\n" +
  "<i>觀中三位修行者由 AI 演繹，其言為角色扮演，非真實個人。\n你的對話用於提供服務，請勿輸入身分證、密碼、金融帳號等敏感資訊。</i>";

const STILLNESS =
  "<b>問卦之前，請先靜心</b>\n\n" +
  "占卜重在一個「誠」字。問卦前，請靜心至少三十息（約三十秒），摒除雜念，誠心專注地想著你要問的那件事。\n\n" +
  "<i>為何如此？</i>六爻講「心誠則靈」。心浮氣躁、隨意亂問，所起之卦容易雜亂、難以應驗；唯有靜定凝神、一心一念，卦象方能清晰映照你的問題。靜心與否，直接影響卦的準確。\n\n" +
  "若你此刻心緒難平、始終靜不下來，建議改用<b>數字起卦</b>（報三數）——它較不受搖卦當下心緒起伏的干擾，更為直接。\n\n" +
  "<i>一問一卦，慎重以待。</i>";

const HELP_TEXT =
  "<b>幾知觀指南</b>\n\n" +
  "🔮 <b>問卦</b>：直接說想問的事，或先打 /gua。系統會擲卦（搖卦／報三數）後為你解卦。\n" +
  "💬 <b>聊天</b>：直接跟道緣說話即可（不必指令）。好感足時，他/她/牠最有靈魂。\n" +
  "🪙 /sign 每日上香，領靈石與好感（連續七日有大獎）\n" +
  "💰 /wallet 查看你的靈石、了解用途\n" +
  "👥 /who 看三位的好感與境界、隨時切換道緣\n" +
  "📜 /history 翻閱卦歷、重溫舊卦與追問\n" +
  "📖 /collection 卦象圖鑑，看你已收集幾卦\n" +
  "🧠 /memory 查看聊天記憶　/forget 清除記憶\n" +
  "🚪 /gua 明確進入問卦　/start 重新入觀\n\n" +
  "<i>每日免費三卦，每卦含兩次追問。</i>\n" +
  "<i>📜 /about 服務性質與免責須知</i>";
const charKeyboard = {
  inline_keyboard: [[
    { text: "🗡 大師兄", callback_data: "char:daoshi_m" },
    { text: "🌿 師妹", callback_data: "char:daoshi_f" },
    { text: "🐈 觀貓", callback_data: "char:lingshou" },
  ]],
};

/* ---------- 身分與會話 ---------- */
async function ensureUser(tgId: string, name?: string): Promise<string> {
  const { data: idt } = await db.from("identities").select("user_id").eq("provider", "tg").eq("external_id", tgId).maybeSingle();
  if (idt) return idt.user_id;
  const { data: prof } = await db.from("profiles").insert({ display_name: name ?? null }).select("id").single();
  await db.from("identities").insert({ provider: "tg", external_id: tgId, user_id: prof!.id });
  await db.rpc("apply_lingshi", { p_user: prof!.id, p_action: "register", p_amount: GRANT_REGISTER });
  return prof!.id;
}
async function getSession(tgId: string) {
  const { data } = await db.from("tg_sessions").select("*").eq("tg_id", tgId).maybeSingle();
  return data ?? { tg_id: tgId, state: "idle", pending_question: null, last_cast_id: null, character_id: null };
}
const saveSession = (s: Record<string, unknown>) =>
  db.from("tg_sessions").upsert({ ...s, updated_at: new Date().toISOString() });

/* ---------- 訊息處理 ---------- */
async function onMessage(msg: { chat: { id: number }; from: { id: number; first_name?: string }; text?: string; photo?: unknown; sticker?: unknown; voice?: unknown; document?: unknown; video?: unknown; audio?: unknown }) {
  const chatId = msg.chat.id, tgId = String(msg.from.id);
  const text = (msg.text ?? "").trim();
  const userId = await ensureUser(tgId, msg.from.first_name);
  const ses = await getSession(tgId);

  // 非文字訊息（圖片/貼圖/語音/檔案等）：bot 只懂文字，以角色口吻婉拒，不靜默卡死
  if (!text && (msg.photo || msg.sticker || msg.voice || msg.document || msg.video || msg.audio)) {
    const cid = ses.character_id ?? "lingshou";
    const reply: Record<string, string> = {
      daoshi_m: "（大師兄看了一眼，沒接）這些我看不懂。有話，寫字。",
      daoshi_f: "（師妹歪了歪頭）這個我瞧不明白呢……施主用文字同我說，好嗎？",
      lingshou: "（觀貓嗅了嗅螢幕，嫌棄地別開臉）看不懂。本喵只認字。打字來。",
    };
    await send(chatId, reply[cid] ?? "我只看得懂文字訊息。");
    return;
  }

  if (text === "/start") {
    await saveSession({ ...ses, state: "idle", pending_question: null });
    await send(chatId,
      "山霧未散，你推開了<b>幾知觀</b>的門。\n\n" +
      "「藏往知來——天垂象，見吉凶。」門楣上的字已經很舊了。\n" +
      "觀裡有三位修行者。你的每一卦，都是他們的修行資糧。\n\n" +
      "<b>選一位，結你的道緣：</b>",
      { reply_markup: charKeyboard });
    return;
  }
  if (text === "/help") {
    await send(chatId, HELP_TEXT);
    return;
  }
  if (text === "/about" || text === "/terms" || text === "/免責") {
    await send(chatId, DISCLAIMER);
    return;
  }
  if (text === "/stats") {
    const ADMIN = Deno.env.get("ADMIN_TG_ID") ?? "8674594142";
    if (tgId !== ADMIN) { await send(chatId, "（此為觀主專用。）"); return; }

    // ── 規模／行為／經濟：一次 RPC 算完 ──
    const { data: s } = await db.rpc("admin_stats");
    const n = (v: unknown) => Number(v ?? 0).toLocaleString();
    const CHAR_LABELS2: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀貓" };
    const ACTION_LABELS: Record<string, string> = {
      register: "註冊", signin: "簽到", followup: "追問", extra_cast: "加卦",
      deepen: "展開", comment: "換評", breakthrough: "突破", feedback: "回評",
    };
    let head = "📊 <b>幾知觀後台</b>\n\n";
    if (s) {
      const byChar = (s.casts_by_char ?? {}) as Record<string, number>;
      const charLine = Object.entries(byChar)
        .sort((a, b) => b[1] - a[1])
        .map(([cid, c]) => `${CHAR_LABELS2[cid] ?? cid} ${n(c)}`).join("　") || "—";
      const byAct = (s.ledger_by_action ?? {}) as Record<string, number>;
      const actLine = Object.entries(byAct)
        .sort((a, b) => b[1] - a[1])
        .map(([a, c]) => `${ACTION_LABELS[a] ?? a} ${n(c)}`).join("　") || "—";
      head +=
        `<b>👥 規模</b>\n` +
        `總用戶 ${n(s.users_total)}　今日新增 ${n(s.users_today)}　近7日活躍 ${n(s.users_7d_active)}\n\n` +
        `<b>🔮 行為</b>\n` +
        `總起卦 ${n(s.casts_total)}（今日 ${n(s.casts_today)}）　追問 ${n(s.followups_total)}\n` +
        `聊天則數 ${n(s.chats_total)}（今日 ${n(s.chats_today)}）\n` +
        `各角色起卦：${charLine}\n\n` +
        `<b>💎 經濟</b>\n` +
        `靈石餘額總計 ${n(s.lingshi_balance)}　發放 ${n(s.lingshi_granted)}　消耗 ${n(s.lingshi_spent)}\n` +
        `各動作次數：${actLine}\n\n` +
        `<b>🎯 準驗</b>　已回評 ${n(s.verdict_total)}　待回評 ${n(s.feedback_pending)}\n`;
    }

    // ── 準驗率明細（分角色／分類別）──
    const { data: fbs } = await db.from("feedback")
      .select("verdict, cast_id, casts(character_id, category)")
      .in("verdict", [1, 2, 3]).limit(5000);
    const total = fbs?.length ?? 0;
    if (!total) { await send(chatId, head + "\n<i>（尚無應期回評，準驗明細待累積。）</i>"); return; }
    let p1 = 0, p2 = 0, p3 = 0;
    const byChar: Record<string, [number, number, number]> = {};
    const byCat: Record<string, [number, number, number]> = {};
    for (const f of fbs!) {
      const v = f.verdict as number;
      if (v === 1) p1++; else if (v === 2) p2++; else p3++;
      const c = (Array.isArray(f.casts) ? f.casts[0] : f.casts) as { character_id?: string; category?: string } | null;
      const cid = c?.character_id ?? "?";
      const cat = c?.category ?? "其他";
      (byChar[cid] ??= [0, 0, 0])[v - 1]++;
      (byCat[cat] ??= [0, 0, 0])[v - 1]++;
    }
    const pct = (x: number) => `${Math.round((x / total) * 100)}%`;
    const accRate = (arr: [number, number, number]) => {
      const t = arr[0] + arr[1] + arr[2];
      return t ? `${Math.round(((arr[0] + arr[1] * 0.5) / t) * 100)}%` : "—";
    };
    let msg = head + `\n<b>📈 準驗率明細</b>\n` +
      `總體：✅${p1}（${pct(p1)}）　◐${p2}（${pct(p2)}）　✕${p3}（${pct(p3)}）\n` +
      `<i>綜合準驗率（準1、部分0.5）：${accRate([p1, p2, p3])}</i>\n\n` +
      `<b>分角色</b>\n`;
    for (const [cid, arr] of Object.entries(byChar)) {
      msg += `${CHAR_LABELS2[cid] ?? cid}：${arr[0]}/${arr[1]}/${arr[2]}（準驗 ${accRate(arr)}）\n`;
    }
    msg += `\n<b>分類別</b>\n`;
    for (const [cat, arr] of Object.entries(byCat)) {
      msg += `${cat}：${arr[0]}/${arr[1]}/${arr[2]}（準驗 ${accRate(arr)}）\n`;
    }
    msg += `\n<i>準/部分/不準</i>`;
    await send(chatId, msg);
    return;
  }

  if (text === "/collection" || text === "/卦籤" || text === "/圖鑑") {
    // 查此用戶起過的所有本卦名（去重）
    const { data: rows } = await db.from("casts").select("gua_ben").eq("user_id", userId);
    const owned = new Set((rows ?? []).map((r) => r.gua_ben).filter(Boolean));
    const total = ALL_GUA_NAMES.length;
    const got = ALL_GUA_NAMES.filter((n) => owned.has(n)).length;
    // 八宮分組顯示，每行八卦，已得亮、未得暗
    const lines: string[] = [];
    for (let i = 0; i < ALL_GUA_NAMES.length; i += 8) {
      const group = ALL_GUA_NAMES.slice(i, i + 8)
        .map((n) => owned.has(n) ? `✨${n}` : `▫️${n}`)
        .join("　");
      lines.push(group);
    }
    const pct = Math.round((got / total) * 100);
    await send(chatId,
      `📖 <b>卦象圖鑑</b>　已得 <b>${got}/${total}</b>（${pct}%）\n\n` +
      lines.join("\n") +
      `\n\n<i>✨ 已起出　▫️ 未遇\n每起出一卦，即收入圖鑑。集滿六十四卦，方窺《易》之全貌。</i>`);
    return;
  }
  if (text === "/memory") {
    const { data: ucMem } = await db.from("user_character")
      .select("memory_summary").eq("user_id", userId).eq("character_id", ses.character_id).maybeSingle();
    const { data: msgs } = await db.from("chat_messages")
      .select("role, body, created_at").eq("user_id", userId).eq("character_id", ses.character_id)
      .order("created_at", { ascending: false }).limit(10);
    const summary = ucMem?.memory_summary as string | undefined;
    if (!summary && !msgs?.length) { await send(chatId, "（與當前道緣還沒有聊天記憶。）"); return; }
    const label = CHAR_LABELS[ses.character_id] ?? "道緣";
    let out = `<b>與${label}的記憶</b>\n`;
    if (summary) out += `\n<b>長久記得的</b>\n${esc(summary)}\n`;
    if (msgs?.length) {
      const lines = msgs.reverse().map((m) => `${m.role === "user" ? "你" : label}：${esc((m.body ?? "").slice(0, 40))}`);
      out += `\n<b>近期對話</b>\n` + lines.join("\n");
    }
    out += "\n\n<i>要清除與這位道緣的聊天記憶，打 /forget</i>";
    await send(chatId, out);
    return;
  }
  if (text === "/forget") {
    await send(chatId, `確定要清除與<b>${CHAR_LABELS[ses.character_id] ?? "當前道緣"}</b>的所有聊天記憶嗎？此舉無法復原。`, {
      reply_markup: { inline_keyboard: [[
        { text: "確定清除", callback_data: "forget_yes" },
        { text: "算了", callback_data: "forget_no" },
      ]] },
    });
    return;
  }
  if (text === "/history" || text.startsWith("/history ")) {
    const dateArg = text.startsWith("/history ") ? text.slice(9).trim() : "";
    let q = db.from("casts").select("id, question, gua_ben, created_at").eq("user_id", userId);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      q = q.gte("created_at", dateArg + "T00:00:00+08:00").lt("created_at", dateArg + "T23:59:59+08:00");
    } else if (/^\d{2}-\d{2}$/.test(dateArg)) {
      const yr = new Date().getFullYear();
      q = q.gte("created_at", `${yr}-${dateArg}T00:00:00+08:00`).lt("created_at", `${yr}-${dateArg}T23:59:59+08:00`);
    } else {
      // 預設只顯示三個月內（符合「三個月內為準」的卦理期限）
      const threeMonthsAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
      q = q.gte("created_at", threeMonthsAgo);
    }
    const { data } = await q.order("created_at", { ascending: false }).limit(15);
    if (!data?.length) {
      await send(chatId, dateArg ? `${esc(dateArg)} 沒有卦歷。` : "卦歷尚空。輸入你想問的事，起第一卦。");
      return;
    }
    // 兩段式查 verdict：不靠 PostgREST 巢狀嵌入（FK 一對一偵測／schema cache 都可能讓嵌入靜默回空）
    const castIds = data.map((c) => c.id);
    const { data: fbRows } = await db.from("feedback").select("cast_id, verdict").in("cast_id", castIds);
    const verdictMap = new Map((fbRows ?? []).map((f) => [f.cast_id, f.verdict]));
    const verdictMark = (v: number | null | undefined) => v === 1 ? "✅" : v === 2 ? "◐" : v === 3 ? "✕" : "";
    const rows = data.map((c) => {
      const mark = verdictMark(verdictMap.get(c.id));
      return [{
        text: `${mark}${new Date(new Date(c.created_at).getTime() + 8 * 3600_000).toISOString().slice(5, 10)}〈${(c.question ?? "").slice(0, 13)}〉《${c.gua_ben}》`,
        callback_data: `replay:${c.id}`,
      }];
    });
    await send(chatId, "<b>卦歷</b>　點一筆可重溫舊卦（含解卦與追問，供事後印證）。\n<i>✅準　◐部分　✕不準（應期回評後標記）\n查特定日期：/history 2026-06-15 或 /history 06-15\n※ 三個月以上、未印證的卦歷會自動清理；已印證的永久保留。</i>", {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (!ses.character_id) {
    await send(chatId, "先入觀結道緣。", { reply_markup: charKeyboard });
    return;
  }

  if (text === "/sign") {
    await doSignIn(chatId, userId, ses);
    return;
  }
  if (text === "/who") {
    await showWho(chatId, userId, ses);
    return;
  }
  if (text === "/wallet" || text === "/lingshi") {
    const { data: prof } = await db.from("profiles").select("lingshi").eq("id", userId).single();
    await send(chatId,
      `🪙 <b>你的靈石</b>：${prof?.lingshi ?? 0}\n\n` +
      "<b>靈石用途</b>\n" +
      `・加問一卦：每日 ${FREE_CASTS_PER_DAY} 卦免費，之後每卦 ${COST_EXTRA_CAST} 靈石\n` +
      `・加問追問：每卦含 ${FREE_FOLLOWUPS_PER_CAST} 次免費，之後每次 ${COST_FOLLOWUP} 靈石\n` +
      "・補簽：補回中斷的連續簽到（費用＝中斷天數×5）\n\n" +
      "<b>靈石來源</b>\n" +
      "・每日上香 /sign（連續七日有大獎）\n" +
      "・與道緣結緣、修行突破賞賜");
    return;
  }
  if (text === "/chat") {
    await saveSession({ ...ses, state: "idle" });
    const { data: uc } = await db.from("user_character").select("favor")
      .eq("user_id", userId).eq("character_id", ses.character_id).maybeSingle();
    const greet: Record<string, string> = {
      daoshi_m: "（大師兄擱下卦書）說吧。",
      daoshi_f: "（師妹替你斟了杯茶）想聊些什麼？",
      lingshou: "（觀貓踱過來，尾巴一甩）難得，想跟本喵說話？說吧。",
    };
    await send(chatId, (greet[ses.character_id] ?? "說吧。") + `\n\n<i>好感 ${uc?.favor ?? 0}。直接說話即可；要正式問卦打 /gua。</i>`);
    return;
  }
  if (text === "/gua" || text === "/ask") {
    await saveSession({ ...ses, state: "awaiting_cast", pending_question: null });
    await send(chatId, "要問什麼事，直接輸入。");
    return;
  }

  // 手動追問模式
  if (ses.state === "followup_input" && ses.last_cast_id && text) {
    await saveSession({ ...ses, state: "idle" });
    await doFollowup(chatId, userId, ses.last_cast_id, text);
    return;
  }

  // 報三數模式
  if (ses.state === "num_input" && text) {
    const nums = (text.match(/\d+/g) ?? []).map(Number).slice(0, 3);
    if (nums.length < 3) {
      await send(chatId, "請給三個數字（任意正整數，空格或逗號隔開皆可）。例：23 15 8");
      return;
    }
    await saveSession({ ...ses, state: "idle" });
    await runCast(chatId, userId, tgId, ses, nums as [number, number, number]);
    return;
  }

  // 明確主動問卦入口：用戶剛說「我要問卦」之類，或 awaiting_cast 狀態下又打字（換問題）
  if (ses.state === "awaiting_cast" && text) {
    await saveSession({ ...ses, pending_question: text });
    const ptag = await castPriceTag(tgId);
    await send(chatId, `問事已記下：\n「${esc(text)}」\n\n<i>靜心三十息，誠想所問之事，再起卦。心定，卦方準。</i>\n靜不下心，可改報三數。`, {
      reply_markup: { inline_keyboard: [[
        { text: `🪙 搖卦（${ptag}）`, callback_data: "cast" },
        { text: `🔢 報三數（${ptag}）`, callback_data: "numinput" },
      ]] },
    });
    return;
  }

  // 預設：一般文字都走聊天。AI 判定疑似問卦時，附「起卦」按鈕讓用戶確認
  if (text) {
    await typing(chatId);
    const r = await chat(db, { userId, characterId: ses.character_id, message: text });
    const tierTail = r.tier === "haiku" ? `\n\n<i>好感 ${r.favorLeft}</i>`
      : r.tier === "canned" ? "\n\n<i>（今日免費閒聊已盡、靈石不足，/sign 簽到補靈石）</i>" : "";
    if (r.wantCast) {
      // 記下這句當待問事，給起卦按鈕（用戶點了才進起卦；不點可繼續聊）
      await saveSession({ ...ses, pending_question: text });
      const ptag = await castPriceTag(tgId);
      await send(chatId, (r.statePrefix ? r.statePrefix + "\n" : "") + esc(r.reply) + tierTail, {
        reply_markup: { inline_keyboard: [[
          { text: `🪙 為此起一卦（${ptag}）`, callback_data: "cast" },
          { text: `🔢 報三數起卦（${ptag}）`, callback_data: "numinput" },
        ]] },
      });
    } else {
      await send(chatId, (r.statePrefix ? r.statePrefix + "\n" : "") + esc(r.reply) + tierTail);
    }
    await maybeSignReminder(chatId, userId, ses);
    return;
  }
}

/* ---------- 按鈕處理 ---------- */
async function onCallback(cb: { id: string; from: { id: number; first_name?: string }; message?: { chat: { id: number } }; data?: string }) {
  const chatId = cb.message?.chat.id; if (!chatId) return;
  const tgId = String(cb.from.id);
  const userId = await ensureUser(tgId, cb.from.first_name);
  const ses = await getSession(tgId);
  const data = cb.data ?? "";
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (data.startsWith("char:")) {
    const charId = data.slice(5);
    const keepChatting = ses.state === "chatting";
    // 見面禮：此人從未與任一角色結緣過 → 首次選定道緣，送 15 好感
    const { data: anyBond } = await db.from("user_character")
      .select("character_id").eq("user_id", userId).limit(1);
    const isFirstEver = !anyBond?.length;
    await saveSession({ ...ses, character_id: charId, state: keepChatting ? "chatting" : "idle" });
    if (isFirstEver) {
      await db.from("user_character")
        .upsert({ user_id: userId, character_id: charId, favor: 15 }, { onConflict: "user_id,character_id", ignoreDuplicates: false });
    }
    const greet: Record<string, string> = {
      daoshi_m: "「護道人。」大師兄抬眼看了你一下，又落回卦書上。「有事，直說。」",
      daoshi_f: "「施主來了。」師妹放下手中的籤紙，朝你笑了笑。「想問什麼，慢慢說。」",
      lingshou: "（一隻貓從供桌上跳下來，打量你）「……兩腳獸。有事問事，本喵時間很貴。」",
    };
    await send(chatId, greet[charId]
      + (isFirstEver ? "\n\n<i>（初次結緣，得好感 15——夠你與他好好聊上一陣。）</i>" : "")
      + (keepChatting ? "\n\n<i>（已切換道緣，繼續聊即可。）</i>" : isFirstEver ? "" : "\n\n<i>直接說話即可；要問卦打 /gua。</i>"));
    if (!keepChatting) {
      await send(chatId, HELP_TEXT);
      await send(chatId, DISCLAIMER);
    }
    if (isFirstEver) {
      await send(chatId, STILLNESS);
      await send(chatId,
        "<b>初來乍到，不妨先問一卦試試。</b>\n心中若有懸而未決之事——感情、事業、抉擇皆可，說與我聽。",
        { reply_markup: { inline_keyboard: [[{ text: "🔮 我想問一卦", callback_data: "guide_first_cast" }]] } });
    }
    return;
  }

  if (data === "cast") {
    if (!ses.pending_question) {
      await send(chatId, "先輸入想問的事。"); return;
    }
    await runCast(chatId, userId, tgId, ses);
    return;
  }

  if (data === "numinput") {
    if (!ses.pending_question) {
      await send(chatId, "先輸入想問的事。"); return;
    }
    await saveSession({ ...ses, state: "num_input" });
    await send(chatId,
      "閉目，將所問之事存於心中。\n待心緒沉定，報上<b>三個數字</b>——任意正整數，空格或逗號隔開。\n\n<i>（數由心生，卦由數成。此乃定卦之機。）</i>\n\n例：23 15 8");
    return;
  }

  if (data.startsWith("replay:")) {
    await showReplay(chatId, userId, data.slice(7));
    return;
  }

  if (data === "guide_first_cast") {
    await saveSession({ ...ses, state: "awaiting_cast", pending_question: null });
    await send(chatId,
      "好。<b>把你想問的事，一句話說清楚。</b>\n\n" +
      "<i>訣竅：問得越具體，卦象越能應。</i>\n" +
      "・好的問法：「這份新工作該不該接？」「他這個月會不會聯繫我？」\n" +
      "・模糊的問法：「我的人生會好嗎？」（太大，難應）\n\n" +
      "現在，輸入你的第一問——");
    return;
  }

  if (data === "sign_now") {
    await doSignIn(chatId, userId, ses);
    return;
  }
  if (data === "sign_makeup") {
    await doSignIn(chatId, userId, ses, true);
    return;
  }
  if (data === "sign_reset") {
    await db.from("profiles").update({ sign_streak: 0, last_sign_date: null }).eq("id", userId);
    await doSignIn(chatId, userId, ses);
    return;
  }

  if (data.startsWith("verdict:")) {
    // verdict:castId:n  (1準 2部分 3不準)
    const parts = data.split(":");
    const vCastId = parts[1], v = Number(parts[2]);
    const { data: fb } = await db.from("feedback").select("verdict, cast_id").eq("cast_id", vCastId).maybeSingle();
    if (!fb) { await send(chatId, "找不到這一卦的應期紀錄。"); return; }
    if (fb.verdict && fb.verdict > 0) { await send(chatId, "你已經印證過這一卦了，多謝。"); return; }
    await db.from("feedback").update({ verdict: v, answered_at: new Date().toISOString() }).eq("cast_id", vCastId);
    // 回評送道行（修為）給原卦角色
    const { data: cast } = await db.from("casts").select("character_id").eq("id", vCastId).maybeSingle();
    const cid = cast?.character_id ?? ses.character_id;
    if (cid) {
      const { data: uc } = await db.from("user_character")
        .upsert({ user_id: userId, character_id: cid }, { onConflict: "user_id,character_id", ignoreDuplicates: false })
        .select("cultivation").single();
      await db.from("user_character").update({ cultivation: (uc?.cultivation ?? 0) + 50 }).eq("user_id", userId).eq("character_id", cid);
    }
    const vt = v === 1 ? "應驗了" : v === 2 ? "部分應驗" : "未如卦象";
    await send(chatId, `多謝印證——此卦<b>${vt}</b>。\n你的回饋讓修行者的道行更進（修為 +50）。\n\n<i>每一次印證，都讓卦理更明。</i>`);
    return;
  }

  if (data === "forget_yes") {
    await db.from("chat_messages").delete().eq("user_id", userId).eq("character_id", ses.character_id);
    await db.from("user_character").update({ memory_summary: null }).eq("user_id", userId).eq("character_id", ses.character_id);
    await send(chatId, "（記憶已散。這位道緣不再記得你們聊過的話——但你問過的卦仍在卦歷裡。）");
    return;
  }
  if (data === "forget_no") {
    await send(chatId, "（罷了，記憶留著。）");
    return;
  }

  if (data === "comment") {
    if (!ses.last_cast_id) { await send(chatId, "沒有可評的卦。"); return; }
    // 跳出另外兩個角色（排除當前解卦的角色）
    const { data: cast } = await db.from("casts").select("character_id").eq("id", ses.last_cast_id).maybeSingle();
    const origin = cast?.character_id ?? ses.character_id;
    const others = ["daoshi_m", "daoshi_f", "lingshou"].filter((id) => id !== origin);
    await send(chatId, `想聽哪位也看看這一卦？（消耗靈石 ${COST_COMMENT}）`, {
      reply_markup: { inline_keyboard: [others.map((id) => ({ text: CHAR_LABELS[id], callback_data: `comment_do:${id}` }))] },
    });
    return;
  }
  if (data.startsWith("comment_do:")) {
    if (!ses.last_cast_id) { await send(chatId, "沒有可評的卦。"); return; }
    const newChar = data.slice(11);
    await send(chatId, `（${CHAR_LABELS[newChar]}接過卦來看了看……）`);
    await typing(chatId);
    const r = await commentCast(db, { userId, castId: ses.last_cast_id, newCharacterId: newChar });
    if (r.kind === "not_found") { await send(chatId, "找不到這一卦。"); return; }
    if (r.kind === "paywall") {
      await send(chatId, `換人評卦需 <b>${r.cost} 靈石</b>，你的靈石不足。\n（每日上香 /sign 可得靈石。）`);
      return;
    }
    await send(chatId, `<b>💬 ${CHAR_LABELS[newChar]}的看法</b>\n\n` + mdToTG(r.comment) + `\n\n<i>（換人評卦，靈石 −${r.paid}）</i>`);
    return;
  }

  if (data === "deepen") {
    if (!ses.last_cast_id) { await send(chatId, "沒有可展開的卦。"); return; }
    await send(chatId, "（凝神細推……）");
    await typing(chatId);
    const r = await deepenCast(db, { userId, castId: ses.last_cast_id });
    if (r.kind === "not_found") { await send(chatId, "找不到這一卦。"); return; }
    if (r.kind === "paywall") {
      await send(chatId, `展開完整卦理需 <b>${r.cost} 靈石</b>，你的靈石不足。\n（每日上香 /sign 可得靈石。）`);
      return;
    }
    const paidNote = (!r.cached && r.paid) ? `\n\n<i>（完整卦理，靈石 −${r.paid}）</i>` : r.cached ? "\n\n<i>（此卦已展開過，重看免費）</i>" : "";
    await send(chatId, "<b>📜 完整卦理</b>\n\n" + mdToTG(r.deep) + paidNote);
    return;
  }

  if (data === "fu_input") {
    if (!ses.last_cast_id) { await send(chatId, "沒有可追問的卦。"); return; }
    await saveSession({ ...ses, state: "followup_input" });
    await send(chatId, "<b>關於這一卦，你還有什麼疑惑？</b>\n直接輸入即可。\n<i>（這是延續此卦的追問，師父會就同一卦再為你細說，非重新起卦。）</i>");
    return;
  }

  if (data.startsWith("fu:")) {
    if (!ses.last_cast_id) { await send(chatId, "沒有可追問的卦。"); return; }
    const idx = +data.slice(3);
    const { data: cast } = await db.from("casts").select("suggested").eq("id", ses.last_cast_id).single();
    const q = cast?.suggested?.[idx];
    if (!q) { await send(chatId, "此追問已失效。"); return; }
    await doFollowup(chatId, userId, ses.last_cast_id, q);
    return;
  }
}

const REALM_NAMES = ["煉氣","築基","結丹","元嬰","化神","煉虛","合體","大乘"];

async function showReplay(chatId: number, userId: string, castId: string) {
  const { data: c } = await db.from("casts")
    .select("question, chart, reading, gua_ben, created_at, due_date, deep_reading, character_id")
    .eq("id", castId).eq("user_id", userId).maybeSingle();
  if (!c) { await send(chatId, "找不到這一卦。"); return; }

  const when = new Date(new Date(c.created_at).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  await send(chatId, `📜 <b>重溫舊卦</b>\n${when}　〈${esc(c.question ?? "")}〉`);
  // 盤面（用存檔的 chart 重繪，不重算）
  try {
    await send(chatId, `<pre>${esc(renderChartTG(c.chart as Parameters<typeof renderChartTG>[0]))}</pre>`);
  } catch {
    await send(chatId, `《${c.gua_ben}》（盤面資料較舊，無法重繪）`);
  }
  // 當時的解卦
  if (c.reading) await send(chatId, "<b>當時解卦</b>\n" + mdToTG(c.reading));
  // 追問紀錄
  const { data: fus } = await db.from("followups")
    .select("question, answer, created_at").eq("cast_id", castId).order("created_at", { ascending: true });
  if (fus?.length) {
    for (const f of fus) {
      await send(chatId, `<b>追問</b>｜${esc(f.question)}\n\n${mdToTG(f.answer)}`);
    }
  }
  // 應期印證提示
  if (c.due_date) {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const passed = c.due_date < today;
    await send(chatId, passed
      ? `<i>此卦應期 ${c.due_date} 已過。事情結果如何？歡迎回觀印證。</i>`
      : `<i>此卦應期在 ${c.due_date}，屆時可回來印證。</i>`);
  }
}

async function showWho(chatId: number, userId: string, ses: Record<string, any>) {
  const { data: rows } = await db.from("user_character")
    .select("character_id, favor, realm, cultivation").eq("user_id", userId);
  const { data: prof } = await db.from("profiles").select("lingshi").eq("id", userId).single();
  const stat: Record<string, { favor: number; realm: number; cult: number }> = {};
  for (const r of rows ?? []) stat[r.character_id] = { favor: r.favor ?? 0, realm: r.realm ?? 0, cult: r.cultivation ?? 0 };
  const order = ["daoshi_m", "daoshi_f", "lingshou"];
  const lines = order.map((id) => {
    const s = stat[id] ?? { favor: 0, realm: 0, cult: 0 };
    const cur = ses.character_id === id ? "　← 當前道緣" : "";
    return `<b>${CHAR_LABELS[id]}</b>　好感 ${s.favor}　${REALM_NAMES[s.realm]}（修為 ${s.cult}）${cur}`;
  });
  await send(chatId,
    `🪙 <b>靈石</b>　${prof?.lingshi ?? 0}\n\n` +
    "幾知觀三位修行者，與你的羈絆：\n\n" + lines.join("\n") +
    "\n\n<i>點下方切換道緣（換誰解卦／聊天）。</i>", {
    reply_markup: { inline_keyboard: [order.map((id) => ({ text: CHAR_LABELS[id], callback_data: `char:${id}` }))] },
  });
}

// 七日循環獎勵：[靈石, 好感]，index 0=第1天…6=第7天
const SIGN_REWARDS: [number, number][] = [[10,0],[10,0],[15,5],[15,0],[20,0],[20,0],[50,10]];
const todayTW = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400_000);

async function doSignIn(chatId: number, userId: string, ses: Record<string, any>, makeup = false) {
  const today = todayTW();
  const { data: prof } = await db.from("profiles").select("last_sign_date, sign_streak, signin_total").eq("id", userId).single();
  const last = prof?.last_sign_date as string | null;
  const streak = prof?.sign_streak ?? 0;
  const signinTotal = prof?.signin_total ?? 0;

  if (last === today) { await send(chatId, "今日已上過香。明日再來。"); return; }

  const gap = last ? daysBetween(last, today) : 999;

  // 斷簽（隔了超過一天）且未選擇補簽 → 給補簽選項
  if (last && gap > 1 && !makeup) {
    const cost = Math.max(streak * 5, 5);
    await send(chatId,
      `你的連續上香在第 <b>${streak}</b> 天斷了。\n` +
      `（觀貓叼著一炷冷掉的香瞥你一眼）\n\n要花 <b>靈石 ${cost}</b> 補回昨日這炷香、續上連續嗎？`, {
      reply_markup: { inline_keyboard: [[
        { text: `🪙 花 ${cost} 補簽`, callback_data: "sign_makeup" },
        { text: "重新開始", callback_data: "sign_reset" },
      ]] },
    });
    return;
  }

  // 計算這次的連續天數
  let newStreak: number;
  if (makeup) {
    // 補簽：補回昨天那一炷，連續從中斷處 +1
    const cost = Math.max(streak * 5, 5);
    const { error } = await db.rpc("apply_lingshi", { p_user: userId, p_action: "signin_mend", p_amount: -cost });
    if (error) { await send(chatId, "靈石不足，補不了簽。要不就從頭來過吧。"); return; }
    newStreak = streak + 1;
  } else if (last && gap === 1) {
    newStreak = streak + 1;      // 連續
  } else {
    newStreak = 1;               // 首簽或主動重新開始
  }

  const dayIdx = ((newStreak - 1) % 7);
  const [lingshi, favor] = SIGN_REWARDS[dayIdx];
  const cycleDay = dayIdx + 1;

  await db.rpc("apply_lingshi", { p_user: userId, p_action: "signin", p_amount: lingshi });
  if (favor > 0 && ses.character_id) {
    const { data: uc } = await db.from("user_character")
      .upsert({ user_id: userId, character_id: ses.character_id }, { onConflict: "user_id,character_id", ignoreDuplicates: false })
      .select("favor").single();
    await db.from("user_character").update({ favor: Math.min(FAVOR_CAP, (uc?.favor ?? 0) + favor) })
      .eq("user_id", userId).eq("character_id", ses.character_id);
  }
  // signin_total：累計簽到次數（頭像 a~h 解鎖依據），TG／網頁簽到共用同一計數
  await db.from("profiles").update({ last_sign_date: today, sign_streak: newStreak, signin_total: signinTotal + 1 }).eq("id", userId);

  const big = cycleDay === 7;
  const favorLine = favor > 0 ? `，當前道緣好感 +${favor}` : "";
  const { data: bal } = await db.from("profiles").select("lingshi").eq("id", userId).single();
  await send(chatId,
    `🪙 上香成功（連續第 <b>${newStreak}</b> 天 · 本輪第 ${cycleDay}/7）\n靈石 +${lingshi}${favorLine}\n當前靈石：${bal?.lingshi ?? 0}` +
    (big ? "\n\n<b>✨ 七日圓滿，香火最盛。</b>明日起新的一輪。" : ""));
}

// 低調簽到提醒：當天首次互動且未簽到時，回一句角色化提醒（每日僅一次，用 session 標記）
async function maybeSignReminder(chatId: number, userId: string, ses: Record<string, any>): Promise<void> {
  const today = todayTW();
  if (ses.sign_reminded === today) return; // 今天提醒過了
  const { data: prof } = await db.from("profiles").select("last_sign_date").eq("id", userId).single();
  if (prof?.last_sign_date === today) return; // 今天已簽，不提醒
  await saveSession({ ...ses, sign_reminded: today });
  const hint: Record<string, string> = {
    daoshi_m: "（大師兄頭也不抬）今日的香還沒上。",
    daoshi_f: "（師妹輕聲）對了，今日還沒上香呢。",
    lingshou: "（觀貓尾巴掃過香爐）喂，今日的香火還空著。",
  };
  await send(chatId, (hint[ses.character_id] ?? "今日尚未上香。") + " /sign", {
    reply_markup: { inline_keyboard: [[{ text: "🪙 上香簽到", callback_data: "sign_now" }]] },
  });
}

async function runCast(chatId: number, userId: string, tgId: string, ses: Record<string, any>, numbers?: [number, number, number]) {
  // 即時氛圍回饋（角色聲線）＋ typing，蓋住 AI 生成空窗
  await send(chatId, CASTING_LINE[ses.character_id] ?? "🪙 三錢落盤……");
  await typing(chatId);
  const r = await castAndInterpret(db, {
    userId, quotaKey: `tg:${tgId}`, characterId: ses.character_id,
    question: ses.pending_question, channel: "tg", numbers,
  });
  if (r.kind === "capped") {
    await send(chatId, "幾知觀今日推演已達上限，三位修行者需要歇息。明日請早。");
    await saveSession({ ...ses, state: "idle" });
    return;
  }
  if (r.kind === "intercept") {
    await saveSession({ ...ses, state: "idle", last_cast_id: r.prevCastId });
    await send(chatId, esc(r.message), {
      reply_markup: { inline_keyboard: [[{ text: "↩️ 回舊卦續問", callback_data: "fu_input" }]] },
    });
    return;
  }
  if (r.kind === "paywall") {
    await send(chatId, "今日免費三卦已盡，靈石也不足了。\n（明日簽到可得靈石；訂閱功能尚在閉關中。）");
    await saveSession({ ...ses, state: "idle" });
    return;
  }
  await saveSession({ ...ses, state: "idle", pending_question: null, last_cast_id: r.castId });
  const castNote = numbers ? "\n<i>※ 以三數總和定動爻（數字起卦法，源於梅花易數）</i>" : "";
  await send(chatId, `<pre>${esc(renderChartTG(r.chart))}</pre>` + castNote);
  // 追問按鈕標價：依此卦已用追問數，顯示 (靈石0) 或 (靈石5)
  const fuTag = await followupPriceTag(r.castId);
  const suggRows = (r.suggested ?? []).map((s: string, i: number) => [{ text: `❓ ${s.slice(0, 24)}（${fuTag}）`, callback_data: `fu:${i}` }]);
  // 今日免費卦進度尾註
  const usedNow = await usedCastsToday(tgId);
  const leftNow = FREE_CASTS_PER_DAY - usedNow;
  const quotaNote = leftNow >= 0
    ? `\n\n<i>（今日免費卦尚餘 ${Math.max(leftNow, 0)} 卦${leftNow <= 0 ? "，之後加卦每卦 " + COST_EXTRA_CAST + " 靈石" : ""}）</i>`
    : "";
  await send(chatId, mdToTG(r.reading) + (r.paid ? `\n\n<i>（額度外加卦，靈石 −${r.paid}）</i>` : "") + (r.appendix ?? "") + quotaNote, {
    reply_markup: { inline_keyboard: [
      [{ text: `📜 展開完整卦理（靈石${COST_DEEPEN}）`, callback_data: "deepen" }],
      ...suggRows,
      [{ text: `✍️ 針對此卦再追問（${fuTag}）`, callback_data: "fu_input" }],
      [{ text: `💬 換人評此卦（靈石${COST_COMMENT}）`, callback_data: "comment" }],
    ] },
  });
  if (r.breakthrough) await send(chatId, "⚡ " + esc(r.breakthrough.message));
}

async function doFollowup(chatId: number, userId: string, castId: string, question: string) {
  await send(chatId, "推演中……");
  await typing(chatId);
  const r = await followupInterpret(db, { userId, castId, question });
  if (r.kind === "paywall") {
    await send(chatId, "此卦內含追問已用盡，靈石亦不足。\n（明日簽到可得靈石。）");
    return;
  }
  if (r.kind === "not_found") { await send(chatId, "找不到這一卦。"); return; }
  await send(chatId, `<b>追問</b>｜${esc(question)}\n\n${mdToTG(r.answer)}` + (r.paid ? `\n\n<i>（靈石 −${r.paid}）</i>` : ""), {
    reply_markup: { inline_keyboard: [[{ text: "✍️ 再追問", callback_data: "fu_input" }]] },
  });
  if (r.breakthrough) await send(chatId, "⚡ " + esc(r.breakthrough.message));
}

/* ---------- 入口 ---------- */
Deno.serve(async (req) => {
  // webhook secret 驗證（setWebhook 時指定 secret_token）
  const secret = Deno.env.get("TG_WEBHOOK_SECRET");
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    // 廣播指令攔截（僅管理員 /broadcast 與確認按鈕；其餘放行回原路由）
    const handled = await tryHandleBroadcast(update, db);
    if (handled) return new Response("ok");
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    // 印出完整錯誤到 log（含 stack），方便定位
    console.error("WEBHOOK_ERROR:", e instanceof Error ? e.stack ?? e.message : String(e));
  }
  return new Response("ok"); // 永遠 200，避免 TG 重送風暴
});
