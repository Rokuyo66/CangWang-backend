// _shared/services.ts — 盤面渲染（TG）、Anthropic 呼叫、計費
import { Chart, YAO_NAMES } from "./core.ts";
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
  // 地支順序，判化進化退
  const ZHI = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  const jinTui = (from: string, to: string): string => {
    const a = ZHI.indexOf(from), b = ZHI.indexOf(to);
    if (a < 0 || b < 0) return "";
    const diff = (b - a + 12) % 12;
    if (diff >= 1 && diff <= 6) return "進";   // 順行為化進
    return "退";                                // 逆行為化退
  };

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
      const jt = jinTui(e.zhi, b.zhi);
      bian = ` ➜ ${b.qin}${b.zhi}${b.wx}${jt ? `(化${jt})` : ""}`;
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
const MODEL = Deno.env.get("INTERPRET_MODEL") ?? "claude-sonnet-4-6";

export async function callInterpret(persona: string, chartText: string, opts: {
  followup?: { prevReading: string; question: string };
  deepen?: { briefReading: string };
  comment?: { prevReading: string; prevAuthor?: string };
  yong?: { qin: string; viaShi?: boolean };
}) {
  const ruleText = opts.followup ? FOLLOWUP_RULES : opts.deepen ? DEEPEN_RULES : opts.comment ? COMMENT_RULES : RULES;
  const system = [
    { type: "text", text: ruleText, cache_control: { type: "ephemeral" } },
    { type: "text", text: `【角色聲線】\n${persona}` },
  ];
  const yongHint = opts.yong
    ? `\n\n【用神已取定】此卦用神為「${opts.yong.viaShi ? `世爻（${opts.yong.qin}）` : opts.yong.qin}」，此為問事者已指定之取用，依此為用神論斷，不得另取或改判。`
    : "";
  const messages = opts.followup
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}\n\n【你先前的論斷】\n${opts.followup.prevReading}\n\n【追問】\n${opts.followup.question}`,
      }]
    : opts.deepen
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}\n\n【你給過的精簡結論】\n${opts.deepen.briefReading}\n\n請給出完整卦理推演。`,
      }]
    : opts.comment
    ? [{
        role: "user",
        content: `【盤面】\n${chartText}\n\n【${opts.comment.prevAuthor ?? "另一位修行者"}已給的解卦結論】\n${opts.comment.prevReading}\n\n以上結論出自「${opts.comment.prevAuthor ?? "另一位修行者"}」，不是你。請以你的視角，就這個結論說幾句你的看法；若提及原評卦人，須正確稱呼為「${opts.comment.prevAuthor ?? "對方"}」，不可張冠李戴成別人。`,
      }]
    : [{ role: "user", content: `【盤面】\n${chartText}${yongHint}\n\n請依規則解此卦。` }];

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1600, system, messages }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  const usage = { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 };
  return { ...(opts.followup || opts.deepen ? { reading: text.trim(), suggested: [], due: null, category: null, digest: null } : parseTagged(text)), usage, model: MODEL };
}

/* ---------- 計費 ---------- */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const FREE_CASTS_PER_DAY = 3;
export const FREE_FOLLOWUPS_PER_CAST = 2; // bot 用戶天然已註冊
export const COST_FOLLOWUP = 5;
export const COST_EXTRA_CAST = 10;
export const COST_DEEPEN = 5;      // 展開完整卦理（首次生成扣，重看免費）
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
