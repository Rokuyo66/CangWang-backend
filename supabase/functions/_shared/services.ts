// _shared/services.ts — 盤面渲染（TG）、Anthropic 呼叫、計費
import { Chart, YAO_NAMES, huaJinTui } from "./core.ts";
import { RULES, FOLLOWUP_RULES, DEEPEN_RULES, COMMENT_RULES, parseTagged } from "./rules.ts";

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
// 模型分流：預設一律 Haiku（省成本），只有完整卦理（deepen）升 Sonnet。
// INTERPRET_FORCE_MODEL：管理者測試用，設了則所有 interpret 呼叫強制用該模型。
const MODEL_LITE = Deno.env.get("INTERPRET_MODEL_LITE") ?? "claude-haiku-4-5-20251001";
const MODEL_DEEP = Deno.env.get("INTERPRET_MODEL_DEEP") ?? Deno.env.get("INTERPRET_MODEL") ?? "claude-sonnet-4-6";
const FORCE_MODEL = Deno.env.get("INTERPRET_FORCE_MODEL");
// 各 mode 輸出 token 上限：精簡層絕不給長篇額度，完整卦理才給大額度
const MODE_LIMITS: Record<string, number> = { cast: 1000, followup: 800, comment: 600, deepen: 4000, deepen_cont: 1600 };

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
  continuePartial?: string; // deepen 專用：上一輪被截斷的半成品，以 assistant 預填讓模型從斷點續寫
}) {
  const mode = opts.followup ? "followup" : opts.deepen ? (opts.continuePartial ? "deepen_cont" : "deepen") : opts.comment ? "comment" : "cast";
  const model = FORCE_MODEL || (opts.deepen ? MODEL_DEEP : MODEL_LITE);
  const ruleText = opts.followup ? FOLLOWUP_RULES : opts.deepen ? DEEPEN_RULES : opts.comment ? COMMENT_RULES : RULES;
  const system = [
    { type: "text", text: ruleText, cache_control: { type: "ephemeral" } },
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
    : [{ role: "user", content: `【盤面】\n${chartText}${yongHint}\n\n請依規則解此卦。提醒：正文只寫白話結論與建議（外行人能全懂、220字內、無任何卦理術語），看不準的地方引導追問，術語與推演全部留給完整卦理展開層。` }];

  // 接續補完：把半成品當 assistant 預填，模型會從斷點直接續寫（不重解、不另起新論）
  if (opts.continuePartial) {
    messages.push({ role: "assistant", content: opts.continuePartial.replace(/\s+$/, "") });
  }

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: MODE_LIMITS[mode] ?? 1000, system, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  // usage 以 API 實際值為準；缺欄位時以字數估算並標記 estimated
  const estimated = !data.usage;
  const promptChars = messages.reduce((s: number, m: { content: string }) => s + m.content.length, 0) + ruleText.length + persona.length;
  const usage = {
    in: data.usage?.input_tokens ?? Math.ceil(promptChars * 1.2),
    out: data.usage?.output_tokens ?? Math.ceil(text.length * 1.2),
  };
  // 續寫模式保留開頭空白（拼接時不黏段）；其餘照舊 trim
  const reading = opts.continuePartial ? text.replace(/\s+$/, "") : text.trim();
  return {
    ...(opts.followup || opts.deepen ? { reading, suggested: [], due: null, category: null, digest: null } : parseTagged(text)),
    usage, model, mode, estimated, stopReason: (data.stop_reason ?? null) as string | null,
  };
}

/** 每次 Claude 呼叫記一筆用量（失敗不阻斷主流程） */
export async function logUsage(db: SupabaseClient, p: {
  userId: string | null; mode: string; model: string;
  usage: { in: number; out: number }; estimated: boolean;
}) {
  try {
    await db.from("ai_usage").insert({
      user_id: p.userId, mode: p.mode, model: p.model,
      tokens_in: p.usage.in, tokens_out: p.usage.out, estimated: p.estimated,
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

export const FREE_CASTS_PER_DAY = 3;
export const FREE_FOLLOWUPS_PER_CAST = 2; // bot 用戶天然已註冊
export const COST_FOLLOWUP = 8;
export const COST_EXTRA_CAST = 10;
export const COST_DEEPEN = 15;     // 展開完整卦理（首次生成扣，重看免費；Sonnet 長輸出，中高價位）
export const COST_COMMENT = 5;     // 換人評卦（另一角色評同卦）
export const GRANT_REGISTER = 50;

/** 起卦計費：先吃免費額度，滿則扣靈石。回傳 {ok, paid, reason?} */
export async function billCast(db: SupabaseClient, userId: string, quotaKey: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: q } = await db.from("free_quota").select("*").eq("key", quotaKey).maybeSingle();
  if (!q || q.last_reset !== today) {
    await db.from("free_quota").upsert({ key: quotaKey, used_today: 1, last_reset: today });
    return { ok: true, paid: 0 };
  }
  if (q.used_today < FREE_CASTS_PER_DAY) {
    await db.from("free_quota").update({ used_today: q.used_today + 1 }).eq("key", quotaKey);
    return { ok: true, paid: 0 };
  }
  const { error } = await db.rpc("apply_lingshi", { p_user: userId, p_action: "extra_cast", p_amount: -COST_EXTRA_CAST });
  if (error) return { ok: false, paid: 0, reason: "lingshi" };
  return { ok: true, paid: COST_EXTRA_CAST };
}

/** 追問計費：卦內含 N 次免費，超出扣靈石 */
export async function billFollowup(db: SupabaseClient, userId: string, castId: string) {
  const { data: c } = await db.from("casts").select("followup_used").eq("id", castId).single();
  if (!c) return { ok: false, paid: 0, reason: "not_found" };
  if (c.followup_used < FREE_FOLLOWUPS_PER_CAST) {
    await db.from("casts").update({ followup_used: c.followup_used + 1 }).eq("id", castId);
    return { ok: true, paid: 0 };
  }
  const { error } = await db.rpc("apply_lingshi", { p_user: userId, p_action: "followup", p_amount: -COST_FOLLOWUP, p_ref: castId });
  if (error) return { ok: false, paid: 0, reason: "lingshi" };
  await db.from("casts").update({ followup_used: c.followup_used + 1 }).eq("id", castId);
  return { ok: true, paid: COST_FOLLOWUP };
}
