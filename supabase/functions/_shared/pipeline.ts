// _shared/pipeline.ts — 解卦主管線（渠道無關）
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildChart, castCoins, castByNumbers, chartText, guaName, pickUsePos } from "./core.ts";
import type { Chart } from "./core.ts";
import { normalizeQuestion, INTERCEPT, BREAKTHROUGH, REALMS, REALM_THRESHOLDS, BREAKTHROUGH_LINGSHI } from "./rules.ts";
import { callInterpret, billCast, billFollowup, COST_DEEPEN, COST_COMMENT, endsComplete, logUsage, rateLimited } from "./services.ts";

const TZ_OFFSET = 8; // 台北時區，占期以 UTC+8 計
const DAILY_GLOBAL_CAP = Number(Deno.env.get("DAILY_GLOBAL_CAP") ?? "200"); // 全站日呼叫熔斷

export function nowTaipei() {
  const t = new Date(Date.now() + TZ_OFFSET * 3600_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hour: t.getUTCHours() };
}

/** 全站日呼叫熔斷：超過上限回 true（應拒絕） */
export async function globalCapReached(db: SupabaseClient): Promise<boolean> {
  const since = new Date(Date.now() + TZ_OFFSET * 3600_000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceUtc = new Date(since.getTime() - TZ_OFFSET * 3600_000).toISOString();
  const { count } = await db.from("casts").select("id", { count: "exact", head: true }).gte("created_at", sinceUtc);
  return (count ?? 0) >= DAILY_GLOBAL_CAP;
}

/** 一事不二占（MVP：正規化比對；應期已過或已回訪則放行） */
export async function checkDuplicate(db: SupabaseClient, userId: string, question: string) {
  const norm = normalizeQuestion(question);
  if (norm.length < 4) return null; // 過短問句不比對，避免誤殺
  const { data } = await db
    .from("casts")
    .select("id, question, gua_ben, due_date, created_at, feedback(answered_at)")
    .eq("user_id", userId)
    .eq("question_norm", norm)
    .order("created_at", { ascending: false })
    .limit(1);
  const prev = data?.[0];
  if (!prev) return null;
  const today = new Date(Date.now() + TZ_OFFSET * 3600_000).toISOString().slice(0, 10);
  const duePassed = prev.due_date && prev.due_date < today;
  const answered = Array.isArray(prev.feedback) ? prev.feedback[0]?.answered_at : (prev.feedback as { answered_at?: string } | null)?.answered_at;
  if (duePassed || answered) return null;
  return prev;
}

export function interceptMessage(characterId: string, prev: { question: string; gua_ben: string; created_at: string }) {
  const d = new Date(prev.created_at);
  const date = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  return (INTERCEPT[characterId] ?? INTERCEPT.daoshi_m)
    .replace("{date}", date)
    .replace("{gua}", prev.gua_ben)
    .replace("{q}", (prev.question ?? "").slice(0, 12));
}

/** 起卦＋解卦 全管線 */
export async function castAndInterpret(db: SupabaseClient, p: {
  userId: string; quotaKey: string; characterId: string; question: string; channel: string;
  numbers?: [number, number, number]; // 報三數起卦（路一）；無則模擬擲卦
  lines?: number[];                    // 網頁已起好的卦（路二）：6個值6/7/8/9，初→上。有則用此卦不重起
  yongQin?: string;                    // 前端已取定的用神六親（與盤面一致）
  yongViaShi?: boolean;                // 用神是否取世爻
  castDate?: { y: number; m: number; d: number; hour: number | null }; // 手動排盤自填占時；無則用當下台北時
}) {
  // 0. 全站熔斷＋個人限流
  if (await globalCapReached(db)) return { kind: "capped" as const };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  // 1. 二占
  const dup = await checkDuplicate(db, p.userId, p.question);
  if (dup) return { kind: "intercept" as const, message: interceptMessage(p.characterId, dup), prevCastId: dup.id };

  // 2. 計費
  const bill = await billCast(db, p.userId, p.quotaKey);
  if (!bill.ok) return { kind: "paywall" as const };

  // 3. 排盤（網頁傳卦 or 三數 or 模擬擲卦，皆進同一文王卦引擎）
  //    手動排盤帶自填占時 castDate，年月日時干支據此推；否則以當下台北時
  const { y, m, d, hour } = p.castDate ?? nowTaipei();
  const lines = (p.lines && p.lines.length === 6 && p.lines.every((v) => v >= 6 && v <= 9))
    ? p.lines
    : p.numbers ? castByNumbers(...p.numbers).lines : castCoins().lines;
  const chart = buildChart(lines, y, m, d, hour);
  const ctext = chartText(chart, p.question);

  // 4. 解卦（用神含引擎鎖定之爻位，與前端顯示同一套 pickUsePos）
  const { data: ch } = await db.from("characters").select("persona_prompt, name").eq("id", p.characterId).single();
  const ai = await callInterpret(ch!.persona_prompt, ctext, p.yongQin
    ? { yong: { qin: p.yongQin, viaShi: p.yongViaShi, pos: pickUsePos(chart, p.yongQin, p.yongViaShi) } }
    : {});
  await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });

  // 應期防呆：模型偶會把應期回填到占期之前（過去日期），此為無效應期，一律作廢改 null。
  // 占期即今日，任何早於占期的 due 都不可能是「應期」，避免曆上出現往回設定的紅點。
  const castDay = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (ai.due && ai.due < castDay) {
    console.warn(`[due-guard] due before cast date, dropped: due=${ai.due} cast=${castDay}`);
    ai.due = null;
  }

  // 5. 入庫
  const { data: cast } = await db.from("casts").insert({
    user_id: p.userId, character_id: p.characterId, channel: p.channel,
    question: p.question, question_norm: normalizeQuestion(p.question),
    category: ai.category, lines, chart, gua_ben: chart.benName, gua_bian: chart.bianName,
    palace: chart.palace, reading: ai.reading, digest: ai.digest, suggested: ai.suggested,
    due_date: ai.due, model: ai.model, tokens_in: ai.usage.in, tokens_out: ai.usage.out,
    yong_qin: p.yongQin ?? null, yong_via_shi: p.yongViaShi ?? null,
  }).select("id").single();
  if (ai.due) {
    await db.from("feedback").insert({ cast_id: cast!.id, user_id: p.userId, due_date: ai.due });
  }

  // 6. 修為與突破
  const breakthrough = await addCultivation(db, p.userId, p.characterId, 10, 3);

  // 7. 起卦後附語（只加在回傳給用戶的 reading，不寫入 DB，避免 /history 重播重複）
  let appendix = "";
  // ① 應期預告：有 due_date 才提示——讓回評閉環對用戶可見
  if (ai.due) {
    appendix += `\n\n<i>（此卦應期約在 ${ai.due}，屆時我會來問你準不準——印證過的卦會永久留存。）</i>`;
  }
  // ② 新卦入鑑：首次起出此本卦才提示收集進度（與 /collection 同以 gua_ben 去重）
  const { count: sameGua } = await db.from("casts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", p.userId).eq("gua_ben", chart.benName);
  if ((sameGua ?? 0) <= 1) { // 剛插入這筆即為首解
    const { data: guaRows } = await db.from("casts").select("gua_ben").eq("user_id", p.userId);
    const collected = new Set((guaRows ?? []).map((r) => r.gua_ben).filter(Boolean)).size;
    appendix += `\n\n<i>（✨此卦初解，幾知觀卦鑑已收錄 ${collected}/64。打 /collection 翻閱你的卦鑑。）</i>`;
  }

  return { kind: "ok" as const, castId: cast!.id as string, chart, reading: ai.reading, appendix, suggested: ai.suggested, paid: bill.paid, breakthrough };
}

/** 追問管線 */
export async function followupInterpret(db: SupabaseClient, p: {
  userId: string; castId: string; question: string;
}) {
  const { data: cast } = await db.from("casts")
    .select("id, character_id, question, chart, reading, lines, yong_qin, yong_via_shi")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  const bill = await billFollowup(db, p.userId, p.castId);
  if (!bill.ok) return { kind: bill.reason === "lingshi" ? "paywall" as const : "not_found" as const };

  const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", cast.character_id).single();
  const chart = cast.chart as Chart;
  const ai = await callInterpret(ch!.persona_prompt, chartText(chart, cast.question ?? ""), {
    followup: { prevReading: cast.reading ?? "", question: p.question },
    ...yongOpts(chart, cast.yong_qin, cast.yong_via_shi),
  });
  await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });
  await db.from("followups").insert({ cast_id: p.castId, question: p.question, answer: ai.reading, paid_lingshi: bill.paid });
  const breakthrough = await addCultivation(db, p.userId, cast.character_id, 10, 2);
  return { kind: "ok" as const, answer: ai.reading, paid: bill.paid, breakthrough };
}

/** 首解已取定之用神 → callInterpret 選項（追問/深展/評卦沿用，避免中途改取用神） */
function yongOpts(chart: Chart, yongQin?: string | null, yongViaShi?: boolean | null) {
  return yongQin
    ? { yong: { qin: yongQin, viaShi: yongViaShi ?? undefined, pos: pickUsePos(chart, yongQin, yongViaShi ?? undefined) } }
    : {};
}

/** 修為累加；跨越閾值回傳突破事件 */
async function addCultivation(db: SupabaseClient, userId: string, characterId: string, amount: number, favorGain = 0) {
  const { data: uc } = await db.from("user_character")
    .upsert({ user_id: userId, character_id: characterId }, { onConflict: "user_id,character_id", ignoreDuplicates: false })
    .select("cultivation, realm, favor").single();
  const newCult = (uc?.cultivation ?? 0) + amount;
  const newFavor = (uc?.favor ?? 0) + favorGain;
  let realm = uc?.realm ?? 0;
  let event: { message: string; lingshi: number } | null = null;
  if (realm + 1 < REALM_THRESHOLDS.length && newCult >= REALM_THRESHOLDS[realm + 1]) {
    realm += 1;
    const tianjie = guaName(castCoins().lines.map((v) => (v === 7 || v === 9 ? 1 : 0)));
    const grant = BREAKTHROUGH_LINGSHI[realm] ?? 30;
    await db.rpc("apply_lingshi", { p_user: userId, p_action: "breakthrough", p_amount: grant });
    event = {
      message: (BREAKTHROUGH[characterId] ?? BREAKTHROUGH.daoshi_m)
        .replace("{realm}", REALMS[realm]).replace("{gua}", tianjie) + `\n\n🪙 突破賞賜：靈石 +${grant}`,
      lingshi: grant,
    };
  }
  await db.from("user_character").update({ cultivation: newCult, realm, favor: newFavor })
    .eq("user_id", userId).eq("character_id", characterId);
  return event;
}

/** 換人評卦：另一角色就同卦結論給看法，扣 COST_COMMENT 靈石，不重算卦理 */
export async function commentCast(db: SupabaseClient, p: {
  userId: string; castId: string; newCharacterId: string;
}) {
  const { data: cast } = await db.from("casts")
    .select("id, question, chart, reading, character_id, yong_qin, yong_via_shi")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  const { error: payErr } = await db.rpc("apply_lingshi", { p_user: p.userId, p_action: "comment", p_amount: -COST_COMMENT, p_ref: p.castId });
  if (payErr) return { kind: "paywall" as const, cost: COST_COMMENT };

  // 取原評卦人稱呼，傳給新角色，避免張冠李戴（如觀貓評的卻說成師妹）
  const { data: prevCh } = await db.from("characters").select("name").eq("id", cast.character_id).maybeSingle();
  const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", p.newCharacterId).single();
  const chart = cast.chart as Chart;
  const ai = await callInterpret(ch!.persona_prompt, chartText(chart, cast.question ?? ""), {
    comment: { prevReading: cast.reading ?? "", prevAuthor: prevCh?.name ?? "另一位修行者" },
    ...yongOpts(chart, cast.yong_qin, cast.yong_via_shi),
  });
  await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });
  return { kind: "ok" as const, comment: ai.reading, paid: COST_COMMENT };
}

/** 展開完整卦理（首次生成扣 COST_DEEPEN 靈石；已生成過重看免費）
 *  完整度保證：撞 max_tokens 或結尾斷半句 → 一次 prefill 接續補完；仍不完整 → 退款、不存半成品。 */
export async function deepenCast(db: SupabaseClient, p: {
  userId: string; castId: string;
}) {
  const { data: cast } = await db.from("casts")
    .select("id, character_id, question, chart, reading, deep_reading, yong_qin, yong_via_shi")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  // 已生成過則直接回快照（重看免費、不重呼叫模型——重複請求天然去重）
  if (cast.deep_reading) return { kind: "ok" as const, deep: cast.deep_reading as string, cached: true };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  // 首次展開：扣靈石（不足則擋）
  const { error: payErr } = await db.rpc("apply_lingshi", { p_user: p.userId, p_action: "deepen", p_amount: -COST_DEEPEN, p_ref: p.castId });
  if (payErr) return { kind: "paywall" as const, cost: COST_DEEPEN };

  const refund = () => db.rpc("apply_lingshi", { p_user: p.userId, p_action: "deepen_refund", p_amount: COST_DEEPEN, p_ref: p.castId });

  const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", cast.character_id).single();
  const chart = cast.chart as Chart;
  const ctext = chartText(chart, cast.question ?? "");
  const yong = yongOpts(chart, cast.yong_qin, cast.yong_via_shi);
  try {
    const ai = await callInterpret(ch!.persona_prompt, ctext, { deepen: { briefReading: cast.reading ?? "" }, ...yong });
    await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });
    let deep = ai.reading;
    let incomplete = ai.stopReason === "max_tokens" || !endsComplete(deep);
    if (incomplete) {
      // 一次接續補完：assistant 預填半成品，模型從斷點續寫剩餘段落（不重解卦）
      const cont = await callInterpret(ch!.persona_prompt, ctext, {
        deepen: { briefReading: cast.reading ?? "" }, continuePartial: deep, ...yong,
      });
      await logUsage(db, { userId: p.userId, mode: cont.mode, model: cont.model, usage: cont.usage, estimated: cont.estimated });
      deep = deep.replace(/\s+$/, "") + cont.reading;
      incomplete = cont.stopReason === "max_tokens" || !endsComplete(deep);
    }
    if (incomplete) {
      // 補完仍失敗：退款、回可控錯誤，絕不把半成品當正式結果存檔
      await refund();
      return { kind: "incomplete" as const };
    }
    await db.from("casts").update({ deep_reading: deep }).eq("id", p.castId);
    return { kind: "ok" as const, deep, cached: false, paid: COST_DEEPEN };
  } catch (e) {
    console.error("deepen failed", e);
    await refund();
    return { kind: "incomplete" as const };
  }
}
