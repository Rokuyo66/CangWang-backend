// _shared/services.ts — 盤面渲染（TG）、Anthropic 呼叫、計費
import { YAO_NAMES, huaJinTui } from "./core.ts";
// Chart 是 interface，得走 import type——混在值 import 裡，node 的型別剝除
// （dev/billing-test.mts 就是靠它跑）會照著去 core.ts 找一個不存在的 export。
import type { Chart } from "./core.ts";
import { RULES, FOLLOWUP_RULES, DEEPEN_RULES, COMMENT_RULES, DAILY_FORTUNE_RULES, MONTHLY_RULES, parseTagged, fixGuaciChars } from "./rules.ts";
import type { Qian } from "./qian60.ts";

/* ---------- Markdown → Telegram HTML ----------
   TG 不認 ## / ** / - 清單，轉成 TG HTML（<b>）並做必要轉義。
   注意：必須先轉義 &<>，再套粗體標籤，否則標籤會被吃掉。 */
export function mdToTG(md: string): string {
  const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const out: string[] = [];
  for (let raw of lines) {
    let line = raw.replace(/\s+$/, "");
    // 分隔線
    if (/^\s*---+\s*$/.test(line)) { out.push("———"); continue; }
    // 標題 ## xxx / # xxx → 粗體獨立行
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { out.push("<b>" + applyInline(escHtml(h[1])) + "</b>"); continue; }
    // 清單 - xxx / * xxx → ・xxx
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { out.push("・" + applyInline(escHtml(li[1]))); continue; }
    out.push(applyInline(escHtml(line)));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // 行內：**粗體** → <b>，*斜體/動作* → <i>
  function applyInline(s: string): string {
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    s = s.replace(/(?<![\*])\*(?!\s)(.+?)(?<!\s)\*(?![\*])/g, "<i>$1</i>");
    return s;
  }
}

/* ---------- TG 等寬盤面 ----------
   設計目標：純文字下也能一眼辨識 動爻/化象/世應/空亡/伏神。
   六獸｜六親地支五行｜爻象｜動標→化爻｜世應  逐欄對齊。 */
export function renderChartTG(c: Chart): string {
  const L: string[] = [];
  const pad = (s: string, n: number) => {
    let w = 0;
    for (const ch of s) w += /[\x00-\xff]/.test(ch) ? 1 : 2;
    return s + " ".repeat(Math.max(0, n - w));
  };
  const kongSet = new Set((c.ganzhi.kong ?? "").split(""));

  L.push(`《${c.benName}》${c.palace}宮${c.type}${c.hasMoving ? ` 之《${c.bianName}》` : "（六爻安靜）"}`);
  const tags = [c.chong && "六沖", c.he && "六合", c.bianChong && "變沖", c.bianHe && "變合"].filter(Boolean).join(" ");
  L.push(`${c.ganzhi.year}年 ${c.ganzhi.month}月 ${c.ganzhi.day}日${c.ganzhi.hour ? ` ${c.ganzhi.hour}時` : ""}　空亡:${c.ganzhi.kong}${tags ? "　" + tags : ""}`);
  L.push("─────────────────────────────");

  for (let i = 5; i >= 0; i--) {
    const e = c.ben[i];
    // 陰陽爻象：陽爻實線、陰爻斷開
    const bar = c.benBits[i] ? "███████" : "███　███";
    // 動爻記號：老陽○、老陰✕
    const moveSym = c.moving[i] ? (c.lines[i] === 9 ? "○" : "✕") : "　";
    const kong = kongSet.has(e.zhi) ? "▪空" : "";
    const najia = `${e.qin}${e.zhi}${e.wx}${kong}`;
    const wy = i + 1 === c.shi ? "【世】" : i + 1 === c.ying ? "【應】" : "　　　";
    // 化爻：本爻→變爻，並標化進/化退
    let bian = "";
    if (c.moving[i] && c.bian) {
      const b = c.bian[i];
      const jt = huaJinTui(e.zhi, b.zhi); // 僅同五行相鄰才標進退
      const bk = kongSet.has(b.zhi) ? "▪空" : "";
      bian = ` ➜ ${b.qin}${b.zhi}${b.wx}${bk}${jt ? `(化${jt})` : ""}`;
    }
    L.push(`${c.beasts[i]} ${pad(najia, 10)}${bar} ${moveSym}${wy}${bian}`);
  }

  if (c.fushen.length) {
    L.push("─────────────────────────────");
    for (const f of c.fushen) {
      const fk = kongSet.has(f.zhi) ? "▪空" : "";
      L.push(`🔻伏神 ${f.qin}${f.zhi}${f.wx}${fk}　伏於${YAO_NAMES[f.pos]}爻（飛神${c.ben[f.pos].qin}${c.ben[f.pos].zhi}）`);
    }
  }
  L.push("─────────────────────────────");
  L.push("○老陽動 ✕老陰動 ➜化爻 【世】【應】持爻");
  return L.join("\n");
}

/* ---------- Anthropic ---------- */
const API = "https://api.anthropic.com/v1/messages";
/* ---------- KIMI（Moonshot，OpenAI 相容） ----------
   模型名以 kimi/moonshot 開頭即走此路；其餘照舊走 Anthropic。
   平台分區：大陸版 platform.kimi.com（¥計價）→ KIMI_API_BASE=https://api.moonshot.cn/v1；
   國際版 platform.kimi.ai（$計價）→ 預設值。金鑰跨區不通用，base 必須跟金鑰同區。 */
const KIMI_API_BASE = Deno.env.get("KIMI_API_BASE") ?? "https://api.moonshot.ai/v1";
const isKimiModel = (m: string) => /^(kimi|moonshot)/i.test(m);
// k2-thinking 的推理鏈同樣計入 completion tokens：硬上限須外加思考預算，否則思考吃光額度、正文被截
const KIMI_THINKING_EXTRA = Number(Deno.env.get("KIMI_THINKING_EXTRA") ?? "2000");
// 溫度不猜預設：未設 KIMI_TEMPERATURE 就不帶此參數，交給 Moonshot 各模型自己的預設值
const KIMI_TEMPERATURE = Deno.env.get("KIMI_TEMPERATURE");
// KIMI 硬超時：edge→.cn 跨境慢（實測約 33 tok/s），偶發掛住會拖死整個 function 被平台掐成 546。
// 逾時就 abort 丟錯，交給備援換家重打；上限取 edge 牆鐘（150s）內留得住備援餘裕的值。
const KIMI_TIMEOUT_MS = Number(Deno.env.get("KIMI_TIMEOUT_MS") ?? "100000");
// 卦理規則的快取存活時間。設 "5m" 可退回舊行為（見 system 組裝處的說明）。
const CACHE_TTL = Deno.env.get("PROMPT_CACHE_TTL") ?? "1h";
// 解卦備援模型：主模型呼叫失敗（過載/斷線/非2xx）時換另一家頂上重打一次。
// 主打 Claude 時備援 KIMI（設了 KIMI_API_KEY 才啟用；INTERPRET_FALLBACK_MODEL 可換型號、設 "off" 停用）；
// 主打 KIMI（如 FORCE 測試中）時備援自動反向回 Sonnet。
const FALLBACK_KIMI = Deno.env.get("INTERPRET_FALLBACK_MODEL") ?? "kimi-k2.6";
const FALLBACK_CLAUDE = "claude-sonnet-4-6";
// 模型分流：初解（cast）與完整卦理（deepen）用 Sonnet——首解定用神生剋吉凶、是全卦之錨。
// 追問/評卦原留 Haiku 省成本，但實測會誤讀盤面（伏神爻位講錯、動爻稱靜爻）；
// 卦是本體、全是收費功能，2026-07-21 起一律升 Sonnet 保正確。
// INTERPRET_FORCE_MODEL：管理者測試用，設了則所有 interpret 呼叫強制用該模型。
const MODEL_LITE = Deno.env.get("INTERPRET_MODEL_LITE") ?? "claude-sonnet-4-6";
const MODEL_DEEP = Deno.env.get("INTERPRET_MODEL_DEEP") ?? Deno.env.get("INTERPRET_MODEL") ?? "claude-sonnet-4-6";
const MODEL_CAST = Deno.env.get("INTERPRET_MODEL_CAST") ?? "claude-sonnet-4-6";
// 日運卦用 Haiku：等第與取籤都由程式算定，模型只負責把等第與籤意寫成角色聲線的短文，
// 不承擔任何卦理判斷。這是免費且每人每日一次的功能，成本必須壓住。
const MODEL_FORTUNE = Deno.env.get("INTERPRET_MODEL_FORTUNE") ?? "claude-haiku-4-5-20251001";
// 月誌卷首語：短輸出、不碰卦理、每人每月一次。用 haiku 是刻意的——
// 它是心跡唯一的 AI 開銷，換成 sonnet 就會讓「訂閱不賣 AI 次數」這條線失守。
const MODEL_MONTHLY = Deno.env.get("INTERPRET_MODEL_MONTHLY") ?? "claude-haiku-4-5-20251001";
const FORCE_MODEL = Deno.env.get("INTERPRET_FORCE_MODEL");
// 各 mode 輸出 token 上限：精簡層絕不給長篇額度，完整卦理才給大額度
const MODE_LIMITS: Record<string, number> = { cast: 1000, followup: 800, comment: 600, deepen: 4000, deepen_cont: 1600, fortune: 600, monthly: 500 };

// 句尾收束字元（含 markdown 粗體收尾）：結尾不在此清單＝疑似斷半句
const SENT_END = ["。", "！", "？", "…", "」", "』", "）", "】", "＊", "～", "*", "."];
export function endsComplete(text: string): boolean {
  const t = (text ?? "").trimEnd();
  return !!t && SENT_END.includes(t[t.length - 1]);
}

export async function callInterpret(persona: string, chartText: string, opts: {
  followup?: { prevReading: string; question: string };
  deepen?: { briefReading: string };
  comment?: { prevReading: string; prevAuthor?: string };
  yong?: { qin: string; viaShi?: boolean; pos?: number | null };
  fortune?: { tierLabel: string; qian: Qian; jieqiLine: string }; // 日運卦：等第與籤由程式算定後傳入
  monthly?: { ym: string };   // 月誌卷首語：chartText 位置改放該月紀錄摘要（見 xinji.statsDigest）
  continuePartial?: string; // deepen 專用：上一輪被截斷的半成品，以 assistant 預填讓模型從斷點續寫
}) {
  const mode = opts.followup ? "followup" : opts.deepen ? (opts.continuePartial ? "deepen_cont" : "deepen") : opts.comment ? "comment" : opts.fortune ? "fortune" : opts.monthly ? "monthly" : "cast";
  const model = FORCE_MODEL || (opts.deepen ? MODEL_DEEP : mode === "cast" ? MODEL_CAST : mode === "fortune" ? MODEL_FORTUNE : mode === "monthly" ? MODEL_MONTHLY : MODEL_LITE);
  const ruleText = opts.followup ? FOLLOWUP_RULES : opts.deepen ? DEEPEN_RULES : opts.comment ? COMMENT_RULES : opts.fortune ? DAILY_FORTUNE_RULES : opts.monthly ? MONTHLY_RULES : RULES;
  // 卦理規則約 9,500 token，每次呼叫一字不差 → 快取它。
  // TTL 用 1 小時而非預設的 5 分鐘：本站流量約每小時個位數次解卦，平均間隔已經
  // 超過 5 分鐘，預設 TTL 幾乎每次都 miss，而每次 miss 的寫入要付 1.25 倍——
  // 那樣的快取是在多花錢。1h 寫入雖是 2 倍，但一寫多讀，整體省 7 成上下。
  // 角色聲線放在快取斷點之後：三個角色各有一份，擺進前綴會裂成三份快取。
  const system = [
    { type: "text", text: ruleText, cache_control: { type: "ephemeral", ttl: CACHE_TTL } },
    { type: "text", text: `【角色聲線】\n${persona}` },
  ];
  // 用神提示：所有 mode 一體適用——追問/深展/評卦沿用首解已取定之用神，避免中途改取自打嘴巴
  const yongHint = opts.yong
    ? `\n\n【用神已取定】此卦用神為「${opts.yong.viaShi ? `世爻（${opts.yong.qin}）` : opts.yong.qin}」${
        opts.yong.pos != null ? `，鎖定於${YAO_NAMES[opts.yong.pos]}` : opts.yong.viaShi ? "" : "（不上卦，依伏神論出伏）"
      }，此為問事者已指定之取用，依此為用神論斷，不得另取或改判。${
        mode === "cast" ? "（此提示連同盤面術語僅供你推斷，初步正文中不得出現任何此類字眼。）" : ""
      }`
    : "";
  const messages = opts.followup
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}${yongHint}\n\n【你先前的論斷】\n${opts.followup.prevReading}\n\n【追問】\n${opts.followup.question}`,
      }]
    : opts.deepen
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}${yongHint}\n\n【你給過的精簡結論】\n${opts.deepen.briefReading}\n\n請給出完整卦理推演。`,
      }]
    : opts.comment
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}${yongHint}\n\n【${opts.comment.prevAuthor ?? "另一位修行者"}已給的解卦結論】\n${opts.comment.prevReading}\n\n以上結論出自「${opts.comment.prevAuthor ?? "另一位修行者"}」，不是你。請以你的視角，就這個結論說幾句你的看法；若提及原評卦人，須正確稱呼為「${opts.comment.prevAuthor ?? "對方"}」，不可張冠李戴成別人。`,
      }]
    : opts.monthly
    ? [{
        role: "user",
        content: `【${opts.monthly.ym} 的紀錄】\n${chartText}\n\n請依規則寫這一卷的卷首語。`,
      }]
    : opts.fortune
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}\n\n【今日節氣】\n${opts.fortune.jieqiLine}\n\n` +
          `【今日等第】${opts.fortune.tierLabel}（排盤程式依世爻旺衰判定之事實，不得改判）\n\n` +
          `【今日之籤】第${opts.fortune.qian.n}籤　${opts.fortune.qian.gz}\n` +
          `${opts.fortune.qian.poem.join("，")}。\n` +
          `卦頭：${opts.fortune.qian.allusion}\n\n` +
          `此籤是依上述等第自同等第籤池取出，與卦象同向。請依規則寫今日運勢：只取詩的意境，不得照字面談婚姻／官司／疾病／科舉，不給應期、不預測具體事件，150字內。`,
      }]
    : [{ role: "user", content: `【盤面】\n${chartText}${yongHint}\n\n請依規則解此卦。提醒：正文只寫白話結論與建議（外行人能全懂、220字內、無任何卦理術語），看不準的地方引導追問，術語與推演全部留給完整卦理展開層。` }];

  // 接續補完：把半成品當 assistant 預填，模型會從斷點直接續寫（不重解、不另起新論）
  if (opts.continuePartial) {
    messages.push({ role: "assistant", content: opts.continuePartial.replace(/\s+$/, "") });
  }

  const maxTokens = MODE_LIMITS[mode] ?? 1000;

  // 呼叫指定模型一次（依模型名分流供應商），回統一形狀
  const callModel = async (m: string): Promise<{ text: string; stopReason: string | null; rawIn?: number; rawOut?: number; cacheWrite?: number; cacheRead?: number }> => {
    if (isKimiModel(m)) {
      // OpenAI 相容格式：system 併成單一 system message；續寫預填用 Moonshot partial mode
      const kimiMessages = [
        { role: "system", content: `${ruleText}\n\n【角色聲線】\n${persona}` },
        ...messages.map((msg2, i) =>
          msg2.role === "assistant" && i === messages.length - 1 && opts.continuePartial
            ? { role: "assistant", content: msg2.content, partial: true }
            : { role: msg2.role, content: msg2.content }
        ),
      ];
      // k2.x 預設「思考開啟」：推理鏈吃光 completion 額度會回空正文（實測 content=""），
      // 解卦不需要外顯推理 → 一律關閉；點名要思考的型號（*thinking/k3）才保留並加額度。
      const wantsReasoning = /thinking|kimi-k3/i.test(m);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), KIMI_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${KIMI_API_BASE}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "authorization": `Bearer ${Deno.env.get("KIMI_API_KEY")}` },
          body: JSON.stringify({
            model: m,
            max_tokens: maxTokens + (wantsReasoning ? KIMI_THINKING_EXTRA : 0),
            messages: kimiMessages,
            stream: false,
            ...(wantsReasoning ? {} : { thinking: { type: "disabled" } }),
            ...(KIMI_TEMPERATURE != null ? { temperature: Number(KIMI_TEMPERATURE) } : {}),
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`kimi ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      // 只取正文；推理鏈在 reasoning_content，另防 <think> 內嵌洩漏
      const text = (msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
      // finish_reason 映射成 Anthropic 語彙，deepen 續寫判斷（max_tokens）才接得上
      const fr = data.choices?.[0]?.finish_reason ?? null;
      return {
        text,
        stopReason: fr === "length" ? "max_tokens" : fr,
        rawIn: data.usage?.prompt_tokens,
        rawOut: data.usage?.completion_tokens,
      };
    }
    const post = (sys: unknown) => fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: m, max_tokens: maxTokens, system: sys, messages }),
    });
    let res = await post(system);
    // ttl 若不被接受就退回預設 5 分鐘重打一次。解卦是主要功能，
    // 不能因為一個快取參數整條路斷掉——寧可少省一點錢。
    if (res.status === 400) {
      const body = await res.text();
      if (/ttl|cache_control/i.test(body)) {
        console.warn("cache ttl rejected, retrying with default TTL:", body.slice(0, 200));
        res = await post(system.map((b) => b.cache_control ? { ...b, cache_control: { type: "ephemeral" } } : b));
      } else {
        throw new Error(`anthropic 400: ${body}`);
      }
    }
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n"),
      stopReason: (data.stop_reason ?? null) as string | null,
      // input_tokens 只含「未命中快取」的部分，快取的寫入與讀取各自另計。
      // 三個都收才是真實輸入量——少收就會低估成本。
      rawIn: data.usage?.input_tokens,
      rawOut: data.usage?.output_tokens,
      cacheWrite: data.usage?.cache_creation_input_tokens,
      cacheRead: data.usage?.cache_read_input_tokens,
    };
  };

  // 主模型失敗 → 備援換家重打一次；備援也掛才真的丟錯（呼叫端照舊處理）
  const fallbackModel = isKimiModel(model)
    ? FALLBACK_CLAUDE
    : (Deno.env.get("KIMI_API_KEY") && FALLBACK_KIMI !== "off" ? FALLBACK_KIMI : null);
  let usedModel = model;
  let r: Awaited<ReturnType<typeof callModel>>;
  try {
    r = await callModel(model);
  } catch (e) {
    if (!fallbackModel || fallbackModel === model) throw e;
    console.error(`interpret [${model}] fail, fallback → ${fallbackModel}:`, e instanceof Error ? e.message : String(e));
    usedModel = fallbackModel;
    r = await callModel(fallbackModel);
  }
  const { text: rawText, stopReason, rawIn, rawOut, cacheWrite, cacheRead } = r;
  // 干支用字校正擺在最前面，parseTagged 與 reading 兩條路才吃得到同一份修好的字。
  // 擺在 parseTagged 之後的話，digest 與 suggested 會漏掉——那兩個也是要給人看的。
  const text = fixGuaciChars(rawText);

  // usage 以 API 實際值為準；缺欄位時以字數估算並標記 estimated
  const estimated = rawIn == null || rawOut == null;
  const promptChars = messages.reduce((s: number, m: { content: string }) => s + m.content.length, 0) + ruleText.length + persona.length;
  const usage = {
    in: rawIn ?? Math.ceil(promptChars * 1.2),
    out: rawOut ?? Math.ceil(text.length * 1.2),
    cacheWrite: cacheWrite ?? 0,
    cacheRead: cacheRead ?? 0,
  };
  // 續寫模式保留開頭空白（拼接時不黏段）；其餘照舊 trim
  const reading = opts.continuePartial ? text.replace(/\s+$/, "") : text.trim();
  return {
    ...(opts.followup || opts.deepen || opts.fortune || opts.monthly ? { reading, suggested: [], due: null, category: null, digest: null, yong: null } : parseTagged(text)),
    usage, model: usedModel, mode, estimated, stopReason,
  };
}

/** 每次 Claude 呼叫記一筆用量（失敗不阻斷主流程） */
export async function logUsage(db: SupabaseClient, p: {
  userId: string | null; mode: string; model: string;
  usage: { in: number; out: number; cacheWrite?: number; cacheRead?: number }; estimated: boolean;
}) {
  try {
    await db.from("ai_usage").insert({
      user_id: p.userId, mode: p.mode, model: p.model,
      tokens_in: p.usage.in, tokens_out: p.usage.out, estimated: p.estimated,
      // 真實輸入量 = tokens_in + cache_write + cache_read，三欄分開存才算得出
      // 快取命中率與實際成本（寫入 2 倍價、讀取 0.1 倍價，不能混在一起算）
      cache_write_tokens: p.usage.cacheWrite ?? 0,
      cache_read_tokens: p.usage.cacheRead ?? 0,
    });
  } catch (e) {
    console.error("logUsage failed", e);
  }
}

/* ---------- 每分鐘限流 ---------- */
export const RATE_PER_MIN = Number(Deno.env.get("RATE_PER_MIN") ?? "6");

/** 同一 user 每分鐘 AI 請求限流（分鐘桶）。回 true＝超限應拒絕。失敗時放行（限流壞了不擋正常服務）。 */
export async function rateLimited(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const minute = new Date().toISOString().slice(0, 16);
    const { data } = await db.from("rate_minute").select("count").eq("user_id", userId).eq("minute", minute).maybeSingle();
    const n = data?.count ?? 0;
    if (n >= RATE_PER_MIN) return true;
    await db.from("rate_minute").upsert({ user_id: userId, minute, count: n + 1 }, { onConflict: "user_id,minute" });
    // 過期桶順手清（低頻抽樣，避免每請求都掃表）
    if (Math.random() < 0.02) {
      const cutoff = new Date(Date.now() - 3600_000).toISOString().slice(0, 16);
      await db.from("rate_minute").delete().lt("minute", cutoff);
    }
    return false;
  } catch (e) {
    console.error("rateLimited check failed", e);
    return false;
  }
}

/* ---------- 計費 ---------- */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const FREE_CASTS_PER_DAY = Number(Deno.env.get("FREE_CASTS_PER_DAY") ?? "2");
// 追問改為「每日額度」而非「每卦額度」：原本每卦免費 2 次、一天 3 卦，等於每天
// 最多 6 次免費追問；追問是主要互動，這是成本大宗。改成每日 N 次，訂閱方案加碼。
// 走 env 是為了讓你不必重新部署就能調——上線初期這個數字要邊看數據邊抓。
export const FREE_FOLLOWUPS_PER_DAY = Number(Deno.env.get("FREE_FOLLOWUPS_PER_DAY") ?? "2");
// 各方案每日免費追問次數（未列者比照 free）
export const PLAN_FOLLOWUPS: Record<string, number> = { free: FREE_FOLLOWUPS_PER_DAY, guanwei: 3, zhiji: 8, cangwang: 20 };
export const PLAN_CASTS: Record<string, number> = { free: FREE_CASTS_PER_DAY, guanwei: 3, zhiji: 5, cangwang: 8 };
export const COST_FOLLOWUP = 8;
export const COST_EXTRA_CAST = 10;
export const COST_DEEPEN = 15;     // 展開完整卦理（首次生成扣，重看免費；Sonnet 長輸出，中高價位）
export const COST_COMMENT = 5;     // 換人評卦（另一角色評同卦）
export const GRANT_REGISTER = 50;

/** 讀方案：到期即視同 free。全站的「這人是不是付費用戶」都走這一支，免得各處各判一次 */
export async function planOf(db: SupabaseClient, userId: string): Promise<string> {
  const { data } = await db.from("profiles").select("plan, plan_until").eq("id", userId).maybeSingle();
  if (!data || !data.plan || data.plan === "free") return "free";
  if (data.plan_until && new Date(data.plan_until).getTime() < Date.now()) return "free";
  return data.plan as string;
}

/** 台北日界。免費額度一律以 UTC+8 的「今天」為準——追問、聊天、日運都這麼算，
 *  起卦不能自己用 UTC，否則台北時間 00:00–08:00 這八小時，額度表與畫面各說各話。 */
export function taipeiToday() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 某人今日已用的免費卦數（隔日視同 0）。標價與計費必須讀同一支，
 *  否則按鈕上寫「免費」、按下去卻扣了靈石。 */
export async function castFreeUsed(db: SupabaseClient, quotaKey: string) {
  const today = taipeiToday();
  const { data } = await db.from("free_quota").select("used_today, last_reset").eq("key", quotaKey).maybeSingle();
  return { today, used: (data && data.last_reset === today) ? data.used_today : 0 };
}

/** 某人今日還剩幾卦免費（前端標價用）。付費方案吃 PLAN_CASTS，不可寫死 free。 */
export async function castFreeLeft(db: SupabaseClient, quotaKey: string, plan: string) {
  const { used } = await castFreeUsed(db, quotaKey);
  return Math.max(0, (PLAN_CASTS[plan] ?? FREE_CASTS_PER_DAY) - used);
}

/** 起卦計費：先吃免費額度，滿則扣靈石。
 *  回傳 {ok, paid, freeLeft, ...}；扣不動時連 need／lingshi 一併回，
 *  前端才講得出「需 10 顆、你有 3 顆」，而不是只丟一句付費牆。 */
export async function billCast(db: SupabaseClient, userId: string, quotaKey: string, plan = "free") {
  const freeCasts = PLAN_CASTS[plan] ?? FREE_CASTS_PER_DAY;
  const { today, used } = await castFreeUsed(db, quotaKey);
  if (used < freeCasts) {
    await db.from("free_quota").upsert({ key: quotaKey, used_today: used + 1, last_reset: today });
    return { ok: true, paid: 0, freeLeft: freeCasts - used - 1 };
  }
  const { error } = await db.rpc("apply_lingshi", { p_user: userId, p_action: "extra_cast", p_amount: -COST_EXTRA_CAST });
  if (error) {
    const { data: prof } = await db.from("profiles").select("lingshi").eq("id", userId).maybeSingle();
    return { ok: false, paid: 0, freeLeft: 0, reason: "lingshi", need: COST_EXTRA_CAST, lingshi: prof?.lingshi ?? 0 };
  }
  return { ok: true, paid: COST_EXTRA_CAST, freeLeft: 0 };
}

/** 把剛扣的那筆流水接回它買到的東西。
 *  加卦的扣款發生在卦存進資料庫之前（扣不動就不該去呼叫 AI），所以那一刻還沒有 cast id
 *  可以當 p_ref——ledger 那一列的 ref_id 只能事後補。不補的話，收支列表上的「加卦 −10」
 *  就永遠只是一個數字，點開也說不出買到的是哪一卦。
 *  認的是「這個人這個動作、最新一筆還沒接上的」：同一人的扣款是循序發生的，不會認錯。 */
export async function linkLedgerRef(db: SupabaseClient, userId: string, action: string, refId: string) {
  const { data } = await db.from("ledger").select("id")
    .eq("user_id", userId).eq("action", action).is("ref_id", null)
    .order("id", { ascending: false }).limit(1);
  const id = (data as { id: number }[] | null)?.[0]?.id;
  if (id != null) await db.from("ledger").update({ ref_id: refId }).eq("id", id);
}

/** 當日已用的免費追問次數（key 自帶日期，隔日自然歸零，不必另跑清理） */
async function followupFreeUsed(db: SupabaseClient, userId: string) {
  const today = taipeiToday();
  const key = `followfree:${userId}:${today}`;
  const { data } = await db.from("free_quota").select("used_today").eq("key", key).maybeSingle();
  return { key, today, used: data?.used_today ?? 0 };
}

/** 某人今日還剩幾次免費追問（前端顯示用） */
export async function followupFreeLeft(db: SupabaseClient, userId: string, plan: string) {
  const { used } = await followupFreeUsed(db, userId);
  return Math.max(0, (PLAN_FOLLOWUPS[plan] ?? FREE_FOLLOWUPS_PER_DAY) - used);
}

/** 追問計費：每日 N 次免費（依方案），超出扣靈石。
 *  原本是「每卦免費 2 次」——一天三卦就等於六次免費追問，而追問正是最常用的互動，
 *  成本大宗卡在這裡。改成每日額度後，額度與卦數脫鉤，才控得住。
 *  casts.followup_used 仍照舊累加：那是單卦的追問紀錄，前端與卦曆都在讀。 */
export async function billFollowup(db: SupabaseClient, userId: string, castId: string, plan = "free") {
  const { data: c } = await db.from("casts").select("followup_used").eq("id", castId).single();
  if (!c) return { ok: false, paid: 0, reason: "not_found" };
  const bump = () => db.from("casts").update({ followup_used: c.followup_used + 1 }).eq("id", castId);

  const { key, today, used } = await followupFreeUsed(db, userId);
  if (used < (PLAN_FOLLOWUPS[plan] ?? FREE_FOLLOWUPS_PER_DAY)) {
    await db.from("free_quota").upsert({ key, used_today: used + 1, last_reset: today });
    await bump();
    return { ok: true, paid: 0 };
  }
  const { error } = await db.rpc("apply_lingshi", { p_user: userId, p_action: "followup", p_amount: -COST_FOLLOWUP, p_ref: castId });
  if (error) return { ok: false, paid: 0, reason: "lingshi" };
  await bump();
  return { ok: true, paid: COST_FOLLOWUP };
}

/* ---------- 初次引導（0031 的 profiles.guide_seen_at） ---------- */

/** 蓋上「看過初次引導」的記號。回傳 ok=false 就是真的沒寫進去，呼叫端必須讓它出聲。
 *
 *  兩件事刻意做在這裡而不是散在端點上：
 *  ① 冪等——`.is(guide_seen_at, null)` 讓已經有記號的列不被覆蓋。0031 存的是時間戳而不是
 *     布林，為的是日後「引導改版就依上次看的時間再放一次」；每關一次引導就把時間往前推，
 *     那個判斷永遠不會成立，時間戳也就白存了。
 *  ② 分辨「已經蓋過」與「這個 uid 根本沒有 profiles 列」——兩者的更新都是 0 列，
 *     但前者正常、後者是帳號壞了。不分辨的話，寫不進去的帳號會安安靜靜地每次登入都被
 *     重講一次引導，而沒有任何一處看得出哪裡斷了。
 */
export async function markGuideSeen(db: SupabaseClient, userId: string): Promise<{ ok: boolean; msg?: string }> {
  const { data, error } = await db.from("profiles")
    .update({ guide_seen_at: new Date().toISOString() })
    .eq("id", userId).is("guide_seen_at", null).select("id");
  if (error) return { ok: false, msg: error.message };
  if (data && data.length > 0) return { ok: true };
  const { data: prof, error: readErr } = await db.from("profiles").select("guide_seen_at").eq("id", userId).maybeSingle();
  if (readErr) return { ok: false, msg: readErr.message };
  if (!prof) return { ok: false, msg: "no_profile" };
  return { ok: true };   // 早就蓋過了
}

/** 這個帳號看過初次引導沒有。
 *
 *  只認 guide_seen_at 一個記號的話，整條路只要斷一次就永遠斷了：記號是前端關掉引導那一刻
 *  fire-and-forget 打回來的，而失敗在兩端都被吞掉（前端 catch(e){}、後端不看 error）。
 *  記號沒蓋上，下次登入就再講一次那七句話——每次都講，而且自己不會好。
 *
 *  所以記號不在時再問一句「這人問過卦沒有」：問過卦的帳號不可能還停在第一次登入。
 *  有卦就順手補蓋記號，補完之後就走上面那條不必多查的路——
 *  代價是「帳號還沒有半卦」的人才多一支 count(head)，那正是唯一該跳引導的人。
 */
export async function guideSeenOf(db: SupabaseClient, userId: string, guideSeenAt: string | null | undefined): Promise<boolean> {
  if (guideSeenAt) return true;
  const { count } = await db.from("casts").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (!count) return false;
  await markGuideSeen(db, userId);
  return true;
}
