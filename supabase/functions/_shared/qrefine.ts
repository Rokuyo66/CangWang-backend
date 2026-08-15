// _shared/qrefine.ts — 問句品質：本地預檢（零成本）＋ Haiku 擬題改寫
// 立場：只提議、不攔阻。任何失敗、超時、超額一律靜默放行（ok:true），絕不擋住起卦。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { QUESTION_CRAFT } from "./rules.ts";
import { s2t } from "./chat.ts";
import { logUsage } from "./services.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const REFINE_MODEL = Deno.env.get("REFINE_MODEL") ?? "claude-haiku-4-5-20251001";
const REFINE_TIMEOUT_MS = Number(Deno.env.get("REFINE_TIMEOUT_MS") ?? "6000");
export const REFINE_PER_DAY = Number(Deno.env.get("REFINE_PER_DAY") ?? "20"); // 每人每日預檢上限（防刷；超過靜默放行）

export const YONG_QIN = ["妻財", "官鬼", "父母", "子孫", "兄弟"];

/** 模型回的用神字串 → 前端/後端通用結構；不認得回 null（交還既有取用神流程） */
export function normYong(s: string | null | undefined): { qin: string; viaShi?: boolean } | null {
  const t = s2t(String(s ?? "").trim());
  if (!t || t === "null" || t === "無") return null;
  if (t.includes("世")) return { qin: "世爻", viaShi: true };
  for (const q of YONG_QIN) if (t.includes(q)) return { qin: q };
  return null;
}

/* ---------- 本地預檢（零延遲零成本；命中才值得呼叫模型） ----------
   ⚠ 前端 part2.html 有同一套規則的 JS 版（needsRefine），改這裡務必同步改那裡。
   缺時限「不」列入觸發條件——多數人本來就不寫時限，每卦都攔會變成嘮叨；改寫時再幫他補上。 */
export function preflight(qRaw: string): { need: boolean; issues: string[] } {
  const q = String(qRaw ?? "").trim();
  const issues: string[] = [];
  if (!q) return { need: false, issues };
  if (q.length < 6) issues.push("太短，看不出你問的是哪件事");
  if (/(還有|另外|順便|以及|同時|順帶)/.test(q) || (q.match(/[?？]/g) ?? []).length > 1) issues.push("一次問了兩件事");
  if (/(怎麼辦|該怎麼|怎樣才|怎麼樣才|為什麼|為何|如何是好|好不好|如何)/.test(q)) issues.push("是開放題，日後無從印證準不準");
  if (/(如果|假如|要是|萬一)/.test(q)) issues.push("帶了假設，卦問不了還沒發生的假設");
  if (/(好煩|好累|崩潰|焦慮|難過|想哭|不知道該|好迷茫|迷惘|心很亂)/.test(q)) issues.push("多是心情，還沒落到具體的事");
  if (/(人生|一輩子|這輩子|未來)/.test(q) && q.length < 14) issues.push("問得太大，卦應不了一輩子");
  return { need: issues.length > 0, issues };
}

export interface RefineResult {
  ok: boolean;                                   // true＝夠好，靜默放行（不出卡）
  issues: string[];                              // 問句的毛病（白話，給用戶看）
  rewrites: string[];                            // 最多三條改寫候選
  yong: { qin: string; viaShi?: boolean } | null; // 改寫同時取定的用神（可直通起卦，省一次彈窗）
}

const PASS: RefineResult = { ok: true, issues: [], rewrites: [], yong: null };

const REFINE_SYS = `你是六爻問事的「擬題師」。你的工作不是解卦，是把護道人講得含糊的話，理成一句能起卦、日後能印證的問句。

${QUESTION_CRAFT}

【你要做的】
1. 判斷原話是否已經是合格問句（四要素齊備、無硬約束違規）。合格就回 ok=true，不要為了改而改。
2. 不合格：列出白話毛病（不用術語，各一句、最多三條），並給二到三條改寫候選。候選之間要有差別——通常是「聚焦不同的事」或「不同的時間窗」，不是同一句換字。
3. 依改寫後的問句取用神六親，填 yong：求財投資生意薪資→妻財；事業求職升遷考試官司災病→官鬼；房車契約文書學歷長輩天氣→父母；子女晚輩平安醫藥寵物出行→子孫；同輩朋友合夥競爭→兄弟；問自身狀態運勢→世爻。感情依所問對象：問男方取官鬼、問女方取妻財；對象不明則 yong 填 null。判不準就填 null。

【輸出】只輸出 JSON，不要任何前後說明、不要程式碼區塊圍籬：
{"ok":true 或 false,"issues":["…"],"rewrites":["…","…"],"yong":"妻財|官鬼|父母|子孫|兄弟|世爻|null"}
ok=true 時 issues 與 rewrites 一律給空陣列。全部繁體中文。`;

/** 每日配額（與聊天共用 free_quota 表；超額或查詢失敗一律放行） */
async function overDailyCap(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const key = `refine:${userId}:${today}`;
    const { data } = await db.from("free_quota").select("used_today, last_reset").eq("key", key).maybeSingle();
    const used = (data && data.last_reset === today) ? data.used_today : 0;
    if (used >= REFINE_PER_DAY) return true;
    await db.from("free_quota").upsert({ key, used_today: used + 1, last_reset: today });
    return false;
  } catch (e) {
    console.error("refine quota check failed, pass", e);
    return false;
  }
}

/** 問句預檢＋改寫。任何異常都回 PASS（靜默放行），絕不阻斷起卦。 */
export async function refineQuestion(db: SupabaseClient, p: { userId: string; question: string }): Promise<RefineResult> {
  const q = String(p.question ?? "").trim();
  if (!q) return PASS;
  const pre = preflight(q);
  if (!pre.need) return PASS;                       // 本地判定夠好 → 不燒 token
  if (await overDailyCap(db, p.userId)) return PASS;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REFINE_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: REFINE_MODEL,
        max_tokens: 400,
        system: [{ type: "text", text: REFINE_SYS, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `【護道人的原話】\n${q}\n\n【本地預檢認為的毛病（僅供參考，你可推翻）】\n${pre.issues.join("；")}` }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    await logUsage(db, {
      userId: p.userId, mode: "refine", model: REFINE_MODEL, estimated: !data.usage,
      usage: { in: data.usage?.input_tokens ?? Math.ceil((REFINE_SYS.length + q.length) * 1.2), out: data.usage?.output_tokens ?? Math.ceil(text.length * 1.2) },
    });
    return parseRefine(text) ?? PASS;
  } catch (e) {
    console.error("refine fail, pass silently", e instanceof Error ? e.message : String(e));
    return PASS;
  } finally {
    clearTimeout(timer);
  }
}

/** 容錯解析：模型偶爾會包 ```json 圍籬或前後多話，抓第一個 {…} 出來 */
export function parseRefine(text: string): RefineResult | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const rewrites = (Array.isArray(j.rewrites) ? j.rewrites : [])
      .map((r: unknown) => s2t(String(r ?? "").trim()))
      .filter((r: string) => r.length >= 4 && r.length <= 40)
      .slice(0, 3);
    const issues = (Array.isArray(j.issues) ? j.issues : [])
      .map((r: unknown) => s2t(String(r ?? "").trim()))
      .filter(Boolean).slice(0, 3);
    // 沒給改寫就等於沒東西可提議 → 放行，不出一張空卡
    if (j.ok === true || !rewrites.length) return PASS;
    return { ok: false, issues, rewrites, yong: normYong(j.yong) };
  } catch {
    return null;
  }
}
