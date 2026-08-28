// _shared/fortune.ts — 每日運勢卦（免費、每日一次、不吃每日三卦額度）
//
// 定位：這是「今日氣象」，不是問事卦。與正式卦分層，永不互相牴觸：
//   ・用神取世爻（問日運無明確標的，取世為己身）
//   ・等第由世爻旺衰硬指標算出（程式判定，非 AI 自由心證）
//   ・籤詩從「同等第籤池」取，故籤永遠不與卦象相反
//   ・不給應期、不建 feedback、不可追問／展開／換評（見 pipeline 的 no_followup 防線）
//   ・不計修為好感、不入卦鑑（category="日運" 於 computeCollection 已排除）

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildChart, castCoins, huaJinTui, YAO_NAMES } from "./core.ts";
import { chartTextFull, actorsOf } from "./dongyao.ts";
import type { Chart } from "./core.ts";
import { pickQian, TIER_LABEL } from "./qian60.ts";
import type { Qian, QianTier } from "./qian60.ts";
import { jieqiOf } from "./jieqi.ts";
import type { JieqiInfo } from "./jieqi.ts";
import { callInterpret, logUsage, rateLimited } from "./services.ts";
import { globalCapReached, nowTaipei } from "./pipeline.ts";
import { FORTUNE_CATEGORY, FORTUNE_QUESTION } from "./rules.ts";

/* ---------- 五行常數 ----------
   與 core.ts 同一套（五行生剋為不變之常數）。此處另置一份，是為了不動 core.ts——
   core.ts 與前端 src/core.ts 是同一份引擎，一改就得連前端重 build 重推。 */
const SHENG: Record<string, string> = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" };
const KE: Record<string, string> = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" };
const ZHI_WX: Record<string, string> = {
  子: "水", 丑: "土", 寅: "木", 卯: "木", 辰: "土", 巳: "火",
  午: "火", 未: "土", 申: "金", 酉: "金", 戌: "土", 亥: "水",
};
const CHONG: Record<string, string> = {
  子: "午", 午: "子", 丑: "未", 未: "丑", 寅: "申", 申: "寅",
  卯: "酉", 酉: "卯", 辰: "戌", 戌: "辰", 巳: "亥", 亥: "巳",
};
// 入墓：亥子墓辰、寅卯墓未、巳午墓戌、申酉墓丑；辰戌丑未為土，土不入墓（與 core.ts 一致）
const MU: Record<string, string> = { 水: "辰", 火: "戌", 金: "丑", 木: "未" };

/** 月令定旺衰：旺2 相1 休0 囚-1 死-2 */
function wangShuai(wx: string, monWx: string): number {
  if (wx === monWx) return 2;
  if (SHENG[monWx] === wx) return 1;
  if (SHENG[wx] === monWx) return 0;
  if (KE[wx] === monWx) return -1;
  return -2;
}
const WS_NAME = ["死", "囚", "休", "相", "旺"];

export interface FortuneTier {
  tier: QianTier;
  score: number;
  notes: string[]; // 計分明細（除錯／日後校準用，不給用戶看）
}

/** 日運等第：以世爻為己身，算日月生剋、動爻作用、化象、格局。
 *  門檻取 >=3 大吉／1~2 吉／-2~0 平／<=-3 宜守——隨機卦盤下約 12/25/35/28%，
 *  最差一級講的是「宜守」而非凶，避免每日提醒變成勸退。 */
export function fortuneTier(c: Chart): FortuneTier {
  const shiIdx = c.shi - 1;
  const shi = c.ben[shiIdx];
  const dayZhi = c.ganzhi.day[1], monZhi = c.ganzhi.month[1];
  const dayWx = ZHI_WX[dayZhi], monWx = ZHI_WX[monZhi];
  const kong = new Set((c.ganzhi.kong ?? "").split(""));

  let score = 0;
  const notes: string[] = [];
  const add = (n: number, why: string) => { score += n; notes.push(`${n > 0 ? "+" : ""}${n} ${why}`); };

  // ① 月令旺衰
  const ws = wangShuai(shi.wx, monWx);
  if (ws !== 0) add(ws, `世爻${shi.zhi}${shi.wx}於${monZhi}月${WS_NAME[ws + 2]}`);

  // ② 日辰（力最大）：臨值 > 沖 > 生剋
  if (shi.zhi === dayZhi) add(2, "世爻臨日建");
  else if (CHONG[dayZhi] === shi.zhi) {
    if (ws > 0) add(1, "日沖旺相靜爻＝暗動");
    else add(-2, "世爻逢日破");
  } else if (SHENG[dayWx] === shi.wx) add(2, "日辰生世");
  else if (KE[dayWx] === shi.wx) add(-2, "日辰剋世");

  // ③ 月建臨沖
  if (shi.zhi === monZhi) add(1, "世爻臨月建");
  else if (CHONG[monZhi] === shi.zhi) add(-1, "世爻月破");

  // ④ 旬空分真假：日月其一旺相為假空（蓄勢待發），均休囚為真空（徹底無力）
  if (kong.has(shi.zhi)) {
    const helped = ws > 0 || shi.zhi === dayZhi || SHENG[dayWx] === shi.wx;
    add(helped ? -1 : -2, helped ? "世爻假空" : "世爻真空");
  }

  // ⑤ 入墓：唯休囚之爻才被關，旺相不入墓（世爻臨日建者以旺論，不入墓）
  if (ws <= 0 && shi.zhi !== dayZhi && (MU[shi.wx] === dayZhi || MU[shi.wx] === monZhi)) add(-1, "世爻入墓");

  // ⑥ 他爻來剋來生世爻——「他爻」的範圍以 dongyao.ts 為準：
  //    發動、日辰入卦、暗動、參戰之變爻皆算，不再只認老陽老陰。
  //    地支同日辰者略過：那股力已在 ② 以「日辰生世／剋世」計過，不重複計次。
  for (const a of actorsOf(c)) {
    if (a.from === "日辰" || a.zhi === dayZhi) continue;
    if (a.pos === shiIdx) continue; // 世爻自身與其變爻另見 ⑦
    const who = `${YAO_NAMES[a.pos]}${a.from === "變爻" ? "變爻" : ""}${a.kind.split("·")[0]}`;
    if (SHENG[a.wx] === shi.wx) add(1, `${who}來生世`);
    else if (KE[a.wx] === shi.wx) add(-1, `${who}來剋世`);
  }

  // ⑦ 世爻自身發動之化象（變爻只作用本位動爻）
  if (c.moving[shiIdx] && c.bian) {
    const b = c.bian[shiIdx];
    if (SHENG[b.wx] === shi.wx) add(2, "世爻化回頭生");
    else if (KE[b.wx] === shi.wx) add(-2, "世爻化回頭剋");
    const jt = huaJinTui(shi.zhi, b.zhi);
    if (jt === "進") add(1, "世爻化進神");
    else if (jt === "退") add(-1, "世爻化退神");
    if (MU[shi.wx] === b.zhi) add(-1, "世爻化墓");
  }

  // ⑧ 格局：六沖主散、六合主和
  if (c.chong) add(-1, "本卦六沖主散");
  if (c.he) add(1, "本卦六合主和");

  const tier: QianTier = score >= 3 ? "daji" : score >= 1 ? "ji" : score >= -2 ? "ping" : "shou";
  return { tier, score, notes };
}

export interface FortuneResult {
  castId: string;
  chart: Chart;
  tier: QianTier;
  tierLabel: string;
  qian: Qian;
  jieqi: JieqiInfo;
  reading: string;
}

const taipeiToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** 每日運勢卦全管線。每人每日一次，以 profiles.last_fortune_date 為閘。 */
export async function dailyFortune(db: SupabaseClient, p: {
  userId: string; characterId: string; channel: string;
}): Promise<
  | ({ kind: "ok" } & FortuneResult)
  | { kind: "already" | "capped" | "rate_limited" | "failed" }
> {
  const today = taipeiToday();
  const { data: prof } = await db.from("profiles").select("last_fortune_date").eq("id", p.userId).maybeSingle();
  const prevDate = (prof?.last_fortune_date as string | null) ?? null;
  if (prevDate === today) return { kind: "already" };
  if (await globalCapReached(db)) return { kind: "capped" };
  if (await rateLimited(db, p.userId)) return { kind: "rate_limited" };

  // 先佔額度再呼叫模型：單條 UPDATE 帶條件，併發同時點只有一邊佔得到，不會重複發卦
  const { data: claimed } = await db.from("profiles")
    .update({ last_fortune_date: today })
    .eq("id", p.userId)
    .or(`last_fortune_date.is.null,last_fortune_date.neq.${today}`)
    .select("id");
  if (!claimed?.length) return { kind: "already" };
  const release = () => db.from("profiles").update({ last_fortune_date: prevDate }).eq("id", p.userId);

  try {
    const { y, m, d, hour } = nowTaipei();
    const chart = buildChart(castCoins().lines, y, m, d, hour);
    const { tier } = fortuneTier(chart);
    const tierLabel = TIER_LABEL[tier];
    // 取籤：等第定池、日辰干支＋世爻地支定池內位置，全確定性無亂數
    const qian = pickQian(tier, chart.ganzhi.day, chart.ben[chart.shi - 1].zhi);
    const jieqi = jieqiOf(y, m, d);

    const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", p.characterId).single();
    const ai = await callInterpret(ch!.persona_prompt, chartTextFull(chart, FORTUNE_QUESTION), {
      fortune: { tierLabel, qian, jieqiLine: jieqi.line },
    });
    await logUsage(db, { userId: p.userId, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });

    const { data: cast } = await db.from("casts").insert({
      user_id: p.userId, character_id: p.characterId, channel: p.channel,
      question: FORTUNE_QUESTION,
      question_norm: null,          // 不進「一事不二占」比對，否則明日同一句會被自己攔下
      category: FORTUNE_CATEGORY,
      lines: chart.lines, chart, gua_ben: chart.benName, gua_bian: chart.bianName,
      palace: chart.palace, reading: ai.reading,
      digest: `今日運勢·${tierLabel}·第${qian.n}籤${qian.gz}`,
      due_date: null,               // 日運不給應期
      model: ai.model, tokens_in: ai.usage.in, tokens_out: ai.usage.out,
    }).select("id").single();

    return { kind: "ok", castId: cast!.id as string, chart, tier, tierLabel, qian, jieqi, reading: ai.reading };
  } catch (e) {
    // 模型或入庫失敗 → 把今日額度還回去，別讓用戶白白損失一次
    console.error("dailyFortune failed", e instanceof Error ? e.stack ?? e.message : String(e));
    await release();
    return { kind: "failed" };
  }
}
