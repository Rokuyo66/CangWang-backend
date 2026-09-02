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
  // 隔了一層的第三人（朋友的老婆、同事的上司）：卦只映照你自己算得出稱謂的人
  if (/(朋友|同事|同學|閨蜜|哥|姊|姐|弟|妹|爸|媽|父母|老公|老婆|男友|女友|前任|前男友|前女友|主管|老闆|上司|客戶)的(老婆|老公|太太|先生|男友|女友|對象|伴侶|小孩|孩子|兒子|女兒|爸|媽|父母|上司|主管|老闆|朋友|同事|同學)/.test(q))
    issues.push("問到隔了一層的人，得換成你自己算得出的稱謂，或把問句掛回你叫得出稱謂的那個人身上");
  // 兩造勝負未表態：世爻無所附麗，斷不了勝負
  if (/(誰(會|能)?(贏|勝|奪冠)|哪(一)?(隊|邊|方|隊伍|支|個)(會|能)?(贏|勝)|勝負|輸贏|奪冠|冠軍)/.test(q)
      && !/(我押|我賭|我支持|我看好|我買|我站|我挺|我傾向|我方|我們(隊|這)|我這邊)/.test(q))
    issues.push("兩邊相爭要先說你心裡傾向哪一方，沒有立場就斷不了勝負");
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
3. 【代占】原話問的是第三人（我妹、我爸、我朋友）：
   ・保留稱謂，不可寫成「他」——沒有稱謂就定不了用神。
   ・隔了一層的人（朋友的老婆、同事的上司、前男友的現任），依序試兩步：①換算成護道人自己的稱謂就換（姊姊的小孩→我外甥、老婆的爸爸→我岳父、哥哥的老婆→我嫂子）；②換不了，就把問句改掛到有稱謂的那個人身上——問的事只要牽動得到他即可（「我朋友的老婆會不會跟他離婚」→「我朋友這段婚姻半年內會不會走到離婚」；「我同事的主管會不會換人」→「我同事這半年會不會換到新主管手下」）。
   ・兩步都不行（那件事只關乎那個外人、與有稱謂者無涉，如「我朋友的老婆會不會升官」）：回 ok=true 放行，不要硬擬——這一層由解卦人在斷語裡說明，擬題層不攔。
   ・其餘可擬的代占句，改寫照常給，另在 issues 補一句白話提醒：代占看得到的是你所知的那一面，準度不如當事人自己問。
4. 【兩造勝負】球賽、選舉這類兩方相爭：問句必須寫明護道人傾向／所押哪一方（例「我押甲隊，這場能贏嗎」）。未表態者，改寫一律帶上表態的位置或直接請他先表態——中立則世爻無所附麗，起不出準卦。此類同投資，不得寫成「押哪隊」「能不能下注」「贏幾分」。
5. yong 欄只管一件事：【感情卦且問句已點明對象性別】問男方填「官鬼」、問女方填「妻財」。其餘所有問事一律填 null——用神由解卦人排角色表當場取定，不由你決定。

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
