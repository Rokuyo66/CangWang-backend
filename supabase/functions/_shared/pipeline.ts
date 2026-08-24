// _shared/pipeline.ts — 解卦主管線（渠道無關）
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildChart, castCoins, castByNumbers, chartText, guaName, pickUsePos } from "./core.ts";
import type { Chart } from "./core.ts";
import { normalizeQuestion, INTERCEPT, BREAKTHROUGH, REALMS, REALM_THRESHOLDS, BREAKTHROUGH_LINGSHI, FORTUNE_CATEGORY } from "./rules.ts";
import { callInterpret, billCast, billFollowup, planOf, linkLedgerRef, COST_DEEPEN, COST_COMMENT, COST_EXTRA_CAST, endsComplete, logUsage, rateLimited } from "./services.ts";

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

// 一事不二占的攔阻時效。過了就當新的一次占問——同一句話隔了夠久再問，
// 問的多半已是另一回事（上個月的「這週會有消息嗎」與這個月的並非同一事）。
const DUP_WINDOW_DUE_DAYS = 30;    // 有應期者：等應期本是規矩，但也不該無限期等下去
const DUP_WINDOW_NODUE_DAYS = 7;   // 無應期者：沒有「應期已過」可解封，不設時效等於永久封死這句話

/** 一事不二占（正規化比對；應期已過、已回評、或超過時效則放行）
 *  雙軌比對：擬題／改寫會讓問句字面改變，只比對最終問句的話，改個字就能重占同一事。
 *  故最終問句與原話兩個正規化值，都要去比對歷史卦的 question_norm 與 question_raw_norm。 */
export async function checkDuplicate(db: SupabaseClient, userId: string, question: string, questionRaw?: string) {
  const norms = [...new Set([normalizeQuestion(question), normalizeQuestion(questionRaw ?? "")])]
    .filter((n) => n.length >= 4); // 過短問句不比對，避免誤殺
  if (!norms.length) return null;
  // normalizeQuestion 已剝掉引號，包雙引號安全；逗號等殘留字元才不會拆散 in 清單
  const list = norms.map((n) => `"${n}"`).join(",");
  const base = () => db.from("casts")
    .select("id, question, gua_ben, due_date, created_at, feedback(answered_at)")
    .eq("user_id", userId);
  let { data, error } = await base()
    .or(`question_norm.in.(${list}),question_raw_norm.in.(${list})`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    // 舊 schema（question_raw_norm 未上）兜底：退回單軌比對，不可讓二占攔截整個失效
    console.error("dup dual-check failed, fallback single", error.message);
    ({ data } = await base().in("question_norm", norms).order("created_at", { ascending: false }).limit(1));
  }
  const prev = data?.[0];
  if (!prev) return null;
  const today = new Date(Date.now() + TZ_OFFSET * 3600_000).toISOString().slice(0, 10);
  const duePassed = prev.due_date && prev.due_date < today;
  const answered = Array.isArray(prev.feedback) ? prev.feedback[0]?.answered_at : (prev.feedback as { answered_at?: string } | null)?.answered_at;
  if (duePassed || answered) return null;
  // 時效：前卦太舊就不再攔。沒有應期的卦原本永遠解不了封——問過一次，那句話就再也問不得；
  // 雙軌比對上線後比中的機會又更高，不設時效等於把「再三瀆」用成了牢籠。
  const ageDays = (Date.now() - new Date(prev.created_at).getTime()) / 86_400_000;
  if (ageDays > (prev.due_date ? DUP_WINDOW_DUE_DAYS : DUP_WINDOW_NODUE_DAYS)) return null;
  // 攔下了就留紀錄：雙軌四組比對命中哪一筆、隔了多久，日後才查得出是不是誤殺
  console.log(`[dup] intercept user=${userId} age=${ageDays.toFixed(1)}d prev=${prev.id} prevQ=${(prev.question ?? "").slice(0, 30)} norms=${norms.join("|")}`);
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
  questionRaw?: string;                // 擬題／改寫前護道人的原話（無擬題則為空）
  questionSource?: string;             // chat_draft（閒聊擬題）/ refined（問事頁改寫）/ manual（自己寫的）
  clientToken?: string;                // 起卦冪等憑據：同一次起卦動作只准成立一卦
  threadId?: string;                   // 心跡：這一卦屬於哪件在記的心事（見下方「二占」）
}) {
  // -1. 冪等：先搶 token。搶不到代表這一次起卦已經有人在做（連點兩下、
  //     斷線重試、或兩台裝置同時送），直接回頭等那一份，不重複扣費與呼叫 AI。
  if (p.clientToken) {
    const { error: claimErr } = await db.from("cast_claims")
      .insert({ token: p.clientToken, user_id: p.userId });
    if (claimErr) {
      const { data: prev } = await db.from("cast_claims")
        .select("cast_id").eq("token", p.clientToken).maybeSingle();
      if (prev?.cast_id) {
        const { data: c } = await db.from("casts")
          .select("id, reading, character_id").eq("id", prev.cast_id).maybeSingle();
        if (c) return { kind: "duplicate" as const, castId: c.id, reading: c.reading ?? "" };
      }
      return { kind: "in_progress" as const };   // 第一份還在批，請前端稍後撈
    }
  }
  // 0. 全站熔斷＋個人限流
  //    熔斷是防「免費用戶把成本打爆」的閘門，付費用戶不該被它擋——付了錢還說
  //    今日額滿，是最傷的體驗。付費者仍受每分鐘限流約束（防濫用，不防成本）。
  const plan = await planOf(db, p.userId);
  if (plan === "free" && await globalCapReached(db)) return { kind: "capped" as const };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  // 1. 二占
  //    帶了 threadId 就不攔。二占要防的是「同一個問題連問到滿意為止」，
  //    但那與「一件事追蹤三個月」是兩回事，差別在他有沒有把它記成一件心事——
  //    記了就等於承認這是同一件事，沒有自欺可言，攔他只是在懲罰誠實的人。
  //    這不是開後門：卦數仍受每日免費額度與靈石管著（第 2 步），
  //    真正擋住濫問的一直是計費，不是這一段。
  let threadId: string | null = null;
  if (p.threadId) {
    const { data: th } = await db.from("threads").select("id, status")
      .eq("id", p.threadId).eq("user_id", p.userId).maybeSingle();
    // 查無、或已了結的線，一律當作沒帶——不能靠送一個假 id 就繞過二占
    if (th && (th as { status: string }).status === "open") threadId = (th as { id: string }).id;
  }
  const dup = threadId ? null : await checkDuplicate(db, p.userId, p.question, p.questionRaw);
  if (dup) return { kind: "intercept" as const, message: interceptMessage(p.characterId, dup), prevCastId: dup.id };

  // 2. 計費
  //    擋下來時把「差多少」一併回：前端才說得出「加卦需 10 靈石，你有 3」，
  //    而不是丟一句沒有數字的付費牆讓人自己猜。
  const bill = await billCast(db, p.userId, p.quotaKey, plan);
  if (!bill.ok) return { kind: "paywall" as const, need: bill.need ?? 0, lingshi: bill.lingshi ?? 0, freeLeft: 0 };

  // 3. 排盤（網頁傳卦 or 三數 or 模擬擲卦，皆進同一文王卦引擎）
  //    手動排盤帶自填占時 castDate，年月日時干支據此推；否則以當下台北時
  const { y, m, d, hour } = p.castDate ?? nowTaipei();
  const lines = (p.lines && p.lines.length === 6 && p.lines.every((v) => v >= 6 && v <= 9))
    ? p.lines
    : p.numbers ? castByNumbers(...p.numbers).lines : castCoins().lines;
  const chart = buildChart(lines, y, m, d, hour);
  const ctext = chartText(chart, p.question);
  // 問事者指定的用神；取「世爻」時六親須由盤面世爻決定——TG 擬題只給得出「世爻」二字，沒有盤面可判
  const askedQin = p.yongQin === "世爻" ? chart.ben[chart.shi - 1].qin : p.yongQin;
  const askedViaShi = p.yongQin === "世爻" ? true : p.yongViaShi;

  // 4. 解卦（用神含引擎鎖定之爻位，與前端顯示同一套 pickUsePos）
  const { data: ch } = await db.from("characters").select("persona_prompt, name").eq("id", p.characterId).single();
  const ai = await callInterpret(ch!.persona_prompt, ctext, askedQin
    ? { yong: { qin: askedQin, viaShi: askedViaShi, pos: pickUsePos(chart, askedQin, askedViaShi) } }
    : {});
  await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });

  // 用神落定：問事者已指定者為準；否則採解卦人依角色表取定並回報之 <yong>。
  // 落定後存檔，追問／完整卦理／換人評卦一律沿用同一用神，不會中途改取自打嘴巴。
  const aiYong = ai.yong as { qin: string | null; viaShi: boolean } | null;
  const yongQin = askedQin ?? (aiYong ? (aiYong.viaShi ? chart.ben[chart.shi - 1].qin : aiYong.qin) : null);
  const yongViaShi = askedViaShi ?? (aiYong ? aiYong.viaShi : null);

  // 應期防呆：模型偶會把應期回填到占期之前（過去日期），此為無效應期，一律作廢改 null。
  // 占期即今日，任何早於占期的 due 都不可能是「應期」，避免曆上出現往回設定的紅點。
  const castDay = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (ai.due && ai.due < castDay) {
    console.warn(`[due-guard] due before cast date, dropped: due=${ai.due} cast=${castDay}`);
    ai.due = null;
  }

  // 5. 入庫
  const row = {
    user_id: p.userId, character_id: p.characterId, channel: p.channel,
    question: p.question, question_norm: normalizeQuestion(p.question),
    category: ai.category, lines, chart, gua_ben: chart.benName, gua_bian: chart.bianName,
    palace: chart.palace, reading: ai.reading, digest: ai.digest, suggested: ai.suggested,
    due_date: ai.due, model: ai.model, tokens_in: ai.usage.in, tokens_out: ai.usage.out,
    yong_qin: yongQin, yong_via_shi: yongViaShi,
    // 原話與來源：日後可比對「擬題過的卦」與「原句卦」的回評準確率
    question_raw: p.questionRaw ?? null,
    question_raw_norm: p.questionRaw ? normalizeQuestion(p.questionRaw) : null,
    question_source: p.questionSource ?? "manual",
    thread_id: threadId,
  };
  let { data: cast, error: insErr } = await db.from("casts").insert(row).select("id").single();
  if (insErr) {
    // 舊 schema（0028 未跑）兜底：去掉新欄位重試。卦錢已扣，這一步絕不可失敗。
    console.error("cast insert with question_raw failed, retry without", insErr.message);
    const { question_raw: _a, question_raw_norm: _b, question_source: _c, thread_id: _d, ...legacy } = row;
    ({ data: cast } = await db.from("casts").insert(legacy).select("id").single());
  }
  if (p.clientToken) {
    // 回填後，同 token 的後續請求就能直接拿到這一卦，而不是再等
    await db.from("cast_claims").update({ cast_id: cast!.id }).eq("token", p.clientToken);
  }
  // 額度外加卦：把那筆扣款接回這一卦，收支列表展開時才說得出買到的是什麼
  if (bill.paid > 0) await linkLedgerRef(db, p.userId, "extra_cast", cast!.id as string);
  if (ai.due) {
    await db.from("feedback").insert({ cast_id: cast!.id, user_id: p.userId, due_date: ai.due });
  }
  // 心跡：把這條線的「最後一卦」往前推。timeline 依它排序，brewNotes 依它算擱了幾天——
  // 不推的話，剛問完的線會被排到底下，而角色隔天就來問「怎麼擱著了」。
  if (threadId) await db.from("threads").update({ last_cast_at: new Date().toISOString() }).eq("id", threadId);

  // 6. 修為與突破
  const breakthrough = await addCultivation(db, p.userId, p.characterId, 10, 3);

  // 7. 起卦後附語（只加在回傳給用戶的 reading，不寫入 DB，避免 /history 重播重複）
  let appendix = "";
  // ① 應期預告：有 due_date 才提示——讓回評閉環對用戶可見
  if (ai.due) {
    appendix += `\n\n<i>（此卦應期約在 ${ai.due}，屆時我會來問你準不準——印證過的卦會永久留存。）</i>`;
  }
  // ② 新卦入鑑：首次起出此本卦才提示收集進度（與 /collection 同以 gua_ben 去重、同樣不計日運卦）
  const { data: guaRows } = await db.from("casts").select("gua_ben, category").eq("user_id", p.userId);
  const guaOnly = (guaRows ?? []).filter((r) => r.category !== FORTUNE_CATEGORY);
  const sameGua = guaOnly.filter((r) => r.gua_ben === chart.benName).length;
  if (sameGua <= 1) { // 剛插入這筆即為首解
    const collected = new Set(guaOnly.map((r) => r.gua_ben).filter(Boolean)).size;
    appendix += `\n\n<i>（✨此卦初解，幾知觀卦鑑已收錄 ${collected}/64。打 /collection 翻閱你的卦鑑。）</i>`;
  }

  // yong 一併回傳：前端據此把盤面的用/原/忌/仇標記補上（起卦當下不再要求用戶先選用神）
  // freeLeft 一併回：起完這一卦，下一卦是白揭還是償香火當場就定了，
  // 前端不必再打一次 profile 才敢改按鈕上的標價。
  return {
    kind: "ok" as const, castId: cast!.id as string, chart, reading: ai.reading, appendix,
    suggested: ai.suggested, paid: bill.paid, freeLeft: bill.freeLeft ?? 0,
    castCost: COST_EXTRA_CAST, breakthrough,
    yong: yongQin ? { qin: yongQin, viaShi: !!yongViaShi } : null,
  };
}

/** 追問管線 */
export async function followupInterpret(db: SupabaseClient, p: {
  userId: string; castId: string; question: string;
}) {
  const { data: cast } = await db.from("casts")
    .select("id, character_id, question, chart, reading, lines, yong_qin, yong_via_shi, category")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  if (cast.category === FORTUNE_CATEGORY) return { kind: "no_followup" as const };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" as const };

  const bill = await billFollowup(db, p.userId, p.castId, await planOf(db, p.userId));
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
    .select("id, question, chart, reading, character_id, yong_qin, yong_via_shi, category")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  if (cast.category === FORTUNE_CATEGORY) return { kind: "no_followup" as const };
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
    .select("id, character_id, question, chart, reading, deep_reading, yong_qin, yong_via_shi, category")
    .eq("id", p.castId).eq("user_id", p.userId).single();
  if (!cast) return { kind: "not_found" as const };
  if (cast.category === FORTUNE_CATEGORY) return { kind: "no_followup" as const };
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
