// _shared/qrefine.ts — 問句品質：本地預檢（零成本）＋ Haiku 擬題改寫
// 立場：只提議、不攔阻。任何失敗、超時、超額一律靜默放行（ok:true），絕不擋住起卦。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { QUESTION_CRAFT } from "./rules.ts";
// 二選一偵測與本地預檢住在 qcheck.ts：零依賴、可單獨測，也免得與 chat.ts 成環
import { EITHER_OR_ISSUE, isEitherOr, filterRewrites, preflight } from "./qcheck.ts";
export { EITHER_OR_ISSUE, isEitherOr, preflight } from "./qcheck.ts";
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
【二選一·最常犯·務必照做】原話若是「A 還是 B」「該選哪個」「哪個比較好」：
　・毛病那一欄要明講：這一卦只答得了其中一條路，先挑一條問，另一條等這卦有結果之後再另占。
　・改寫候選**每一句只問一條路**，且要把兩條路各擬一句出來讓他自己挑先問哪個（例：原話「接受新offer還是留在現職」→ 候選一「三個月內接下這份新工作，能不能順利上手？」候選二「三個月內留在現職，能不能有起色？」）。
　・**任何一條候選都不准再出現「還是」「或是」「哪個比較」「該選哪」**——出現一次，整張建議就是錯的，比不給建議傷得更重。
3. yong 欄只管一件事：【感情卦且問句已點明對象性別】問男方填「官鬼」、問女方填「妻財」。其餘所有問事一律填 null——用神由解卦人排角色表當場取定，不由你決定。

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
    const r = parseRefine(text) ?? PASS;
    // 原話是二選一時，模型放行也不算數：那種問句一卦取不出用神，毛病一定要講出來。
    // （候選若全被攔掉，兩個入口都會因為沒得點而回到原本的問法——不阻斷起卦的立場不變。）
    if (isEitherOr(q)) {
      return { ...r, ok: false, issues: [EITHER_OR_ISSUE, ...r.issues.filter((i) => i !== EITHER_OR_ISSUE)].slice(0, 3) };
    }
    return r;
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
    const raw = (Array.isArray(j.rewrites) ? j.rewrites : [])
      .map((r: unknown) => s2t(String(r ?? "").trim()))
      .filter((r: string) => r.length >= 4 && r.length <= 40);
    // 二選一的候選一律丟掉：建議一句取不出用神的問句，比不建議傷得更重（規則已交代，這裡不靠自律）
    const { kept, blocked } = filterRewrites(raw);
    if (blocked.length) console.warn("refine 吐出二選一候選，已攔下：", blocked.join(" / "));
    const rewrites = kept.slice(0, 3);
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
