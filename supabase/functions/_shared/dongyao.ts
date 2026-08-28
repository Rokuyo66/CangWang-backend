// _shared/dongyao.ts — 動爻判定與生剋作用鏈（全系統唯一真相來源）
//
// 【為什麼獨立成檔】2026-08-28 之前，「哪些爻在動」散在三處各判各的：
//   core.ts 只認老陽老陰、case.ts 多認一個暗動、fortune.ts 連暗動都不認。
//   日辰入卦、變爻外剋、沖脫三條則三處皆無。於是丙申月甲戌日《震為雷》之《坤為地》
//   那一卦裡，「上爻妻財戌土臨日建（忌神）剋初爻用神父母子水」整條被漏判，
//   解卦時還被 rules.ts 的「標靜之爻絕不可稱動爻」硬規壓死。
//   本檔把「能動」的全部條件收成一份，其餘檔案一律引用，不再各自判。
//
// 【為什麼不放進 core.ts】core.ts 與前端 src/core.ts 是同一份引擎，一改就得
//   連前端重 build 重推（見 fortune.ts 檔頭同樣的取捨）。本檔純後端、零 I/O、
//   零隨機，只讀 Chart，同一個 Chart 必得同一份判定。
//
// 【判定條件·2026-08-28 裁決】能對他爻作用者，僅以下四類（其餘皆真靜爻）：
//   ① 發動——老陽○老陰✕。動爻逢日沖＝沖脫（進行而後散），仍作用，但主事成而後散。
//   ② 日辰入卦——靜爻地支與日辰之支相同。日辰為六爻主宰，力最強：
//      旺衰直接以旺論（不看月令休囚），生剋沖合俱全。
//      ★ 只有「該地支本身」得此旺，同五行之他支不與焉（戌臨日建，不代表辰丑未也旺）。
//   ③ 暗動——靜爻逢日沖且於月令旺相。具生剋而無沖合之力。
//      （月令休囚者為日破，不作用；日沖再逢月破為破盡。）
//   ④ 變爻參戰——動爻之變爻，若「未曾回頭生、也未曾回頭剋本位動爻」，則視同動爻，
//      可去生剋其他爻；若已回頭生剋本位，作用已盡於本位，不及旁爻。
//      本位動爻真空或沖脫者，變爻不論。
//
// 【日辰本體】日辰不入卦亦生剋沖合全盤（rules.ts「日辰力大：生剋沖合值」），
//   故作用鏈中另列一行。日辰入卦時，該爻與日辰本體同源，勿重複計次。

import { ZHI, YAO_NAMES, chartText, type Chart } from "./core.ts";

/* ═══════════════ 卦理常數（與 core.ts 同源；derive 自 ZHI，見 selfCheck） ═══════════════ */

const ZHI_WX: Record<string, string> = {
  子: "水", 丑: "土", 寅: "木", 卯: "木", 辰: "土", 巳: "火",
  午: "火", 未: "土", 申: "金", 酉: "金", 戌: "土", 亥: "水",
};
const SHENG: Record<string, string> = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" };
const KE: Record<string, string> = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" };
// 相沖：對宮（+6）；六合：子丑 寅亥 卯戌 辰酉 巳申 午未 → j = (1 - i) mod 12
const CHONG: Record<string, string> = Object.fromEntries(ZHI.map((z, i) => [z, ZHI[(i + 6) % 12]]));
const HE6: Record<string, string> = Object.fromEntries(ZHI.map((z, i) => [z, ZHI[((1 - i) % 12 + 12) % 12]]));

export type Wang = "旺" | "相" | "休" | "囚" | "死";

/* ═══════════════ 旺衰 ═══════════════ */

/** 月令定旺相休囚死：同令旺、令生相、生令休、剋令囚、令剋死。辰戌丑未月土旺。 */
export function monthWang(wx: string, monZhi: string): Wang {
  const m = ZHI_WX[monZhi];
  if (wx === m) return "旺";
  if (SHENG[m] === wx) return "相";
  if (SHENG[wx] === m) return "休";
  if (KE[wx] === m) return "囚";
  return "死"; // KE[m] === wx
}
export const isWangXiang = (w: Wang) => w === "旺" || w === "相";

/** 日辰入卦：爻之地支＝日辰之支。★只認該地支本身，不及同五行之他支。 */
export const isRiChen = (zhi: string, c: Chart) => zhi === c.ganzhi.day[1];

/** 實效旺衰：日辰入卦者直接以旺論（日辰最強，凌駕月令）；其餘依月令。
 *  凡以「旺相」為前提之判定（入墓、月破是否致命、暗動……）一律走這裡，不可只看月令。 */
export function effWang(zhi: string, wx: string, c: Chart): Wang {
  if (isRiChen(zhi, c)) return "旺";
  return monthWang(wx, c.ganzhi.month[1]);
}

/** 日月其一旺相——真假空之前提（rules.ts 第 33 行）。 */
export function vigorous(zhi: string, wx: string, c: Chart): boolean {
  if (isWangXiang(monthWang(wx, c.ganzhi.month[1]))) return true;
  if (isRiChen(zhi, c)) return true;
  return SHENG[ZHI_WX[c.ganzhi.day[1]]] === wx; // 日生
}

/* ═══════════════ 單爻動靜判定 ═══════════════ */

/** 暗動：日沖旺相之靜爻。具生剋而無沖合之力。
 *  「旺」只由月令決定——六組地支相沖（子午丑未寅申卯酉辰戌巳亥）的五行關係
 *  只有相剋與比和，沒有一組相生；同支更不可能相沖，故日辰生扶與臨日建在此結構上
 *  皆不可達（selfCheck 第 1 條逐支反查）。 */
export function isAnDong(zhi: string, wx: string, c: Chart, moving: boolean): boolean {
  if (moving) return false;
  if (CHONG[c.ganzhi.day[1]] !== zhi) return false;
  return isWangXiang(monthWang(wx, c.ganzhi.month[1]));
}

/** 沖脫：動爻逢日沖——進行而後散。仍是動爻，仍作用，但主事成而後散。 */
export const isChongTuo = (zhi: string, c: Chart, moving: boolean) =>
  moving && CHONG[c.ganzhi.day[1]] === zhi;

/** 日破：靜爻逢日沖而月令休囚（旺相者為暗動）。不作用。 */
export const isRiPo = (zhi: string, wx: string, c: Chart, moving: boolean) =>
  !moving && CHONG[c.ganzhi.day[1]] === zhi && !isWangXiang(monthWang(wx, c.ganzhi.month[1]));

/** 破盡：日沖＋月破。 */
export const isPoJin = (zhi: string, c: Chart) =>
  CHONG[c.ganzhi.day[1]] === zhi && CHONG[c.ganzhi.month[1]] === zhi;

/** 沖空：旬空之爻逢日沖——事情有變數，吉凶不入卦內。 */
export const isChongKong = (zhi: string, c: Chart) =>
  c.ganzhi.kong.includes(zhi) && CHONG[c.ganzhi.day[1]] === zhi;

/** 真空：旬空且日月均休囚（非真空即假空）。 */
export const isZhenKong = (zhi: string, wx: string, c: Chart) =>
  c.ganzhi.kong.includes(zhi) && !vigorous(zhi, wx, c);

/** 該位之變爻能否對「本位以外」的爻作用。
 *  回頭生／回頭剋者作用已盡於本位；本位真空或沖脫者變爻不論。 */
export function bianActs(c: Chart, i: number): { active: boolean; why: string } {
  if (!c.moving[i] || !c.bian) return { active: false, why: "非動爻無變爻" };
  const e = c.ben[i], b = c.bian[i];
  if (isZhenKong(e.zhi, e.wx, c)) return { active: false, why: "本位動爻真空，變爻不論" };
  if (isChongTuo(e.zhi, c, true)) return { active: false, why: "本位動爻沖脫，變爻不論" };
  if (SHENG[b.wx] === e.wx) return { active: false, why: "已回頭生本位，作用盡於本位" };
  if (KE[b.wx] === e.wx) return { active: false, why: "已回頭剋本位，作用盡於本位" };
  return { active: true, why: "未回頭生剋本位，視同動爻可生剋他爻" };
}

/** 本爻是否為動爻（含視同發動者）。fortune／case／解卦一律以此為準。 */
export function isActive(c: Chart, i: number): boolean {
  const e = c.ben[i];
  return c.moving[i] || isRiChen(e.zhi, c) || isAnDong(e.zhi, e.wx, c, c.moving[i]);
}

/* ═══════════════ 作用者清單 ═══════════════ */

export interface Actor {
  pos: number;             // 0-based 爻位（日辰本體為 -1）
  from: "本爻" | "變爻" | "日辰";
  kind: string;            // 發動／暗動／日辰入卦／變爻參戰／日辰本體
  zhi: string; wx: string; qin: string;
  notes: string[];         // 沖脫／破盡…
  chongHe: boolean;        // 是否具沖合之力（暗動無）
}

const label = (a: Actor) =>
  a.from === "日辰" ? `日辰${a.zhi}${a.wx}【${a.kind}】`
  : `${YAO_NAMES[a.pos]}${a.from === "變爻" ? "變爻" : ""}${a.qin}${a.zhi}${a.wx}【${[a.kind, ...a.notes].join("·")}】`;

export function actorsOf(c: Chart): Actor[] {
  const out: Actor[] = [];
  const dayZhi = c.ganzhi.day[1];
  // 日辰入卦時，該爻與日辰本體地支相同、作用完全重疊，只留一個，免得同一股力被算兩次。
  const ruGua = c.ben.some((e, i) => !c.moving[i] && isRiChen(e.zhi, c));
  if (!ruGua) {
    out.push({ pos: -1, from: "日辰", kind: "日辰本體", zhi: dayZhi, wx: ZHI_WX[dayZhi],
               qin: "", notes: [], chongHe: true });
  }
  c.ben.forEach((e, i) => {
    const notes: string[] = [];
    if (isPoJin(e.zhi, c)) notes.push("破盡");
    if (isChongKong(e.zhi, c)) notes.push("沖空");
    if (c.moving[i]) {
      if (isChongTuo(e.zhi, c, true)) notes.push("沖脫·進行而後散");
      out.push({ pos: i, from: "本爻", kind: "發動", zhi: e.zhi, wx: e.wx, qin: e.qin, notes, chongHe: true });
    } else if (isRiChen(e.zhi, c)) {
      out.push({ pos: i, from: "本爻", kind: "日辰入卦·視同發動", zhi: e.zhi, wx: e.wx, qin: e.qin,
                 notes: [...notes, "以旺論", "兼日辰本體之力"], chongHe: true });
    } else if (isAnDong(e.zhi, e.wx, c, false)) {
      out.push({ pos: i, from: "本爻", kind: "暗動", zhi: e.zhi, wx: e.wx, qin: e.qin,
                 notes: [...notes, "有生剋而無沖合之力"], chongHe: false });
    }
  });
  if (c.bian) {
    c.moving.forEach((mv, i) => {
      if (!mv || !bianActs(c, i).active) return;
      const b = c.bian![i];
      out.push({ pos: i, from: "變爻", kind: "變爻參戰·視同動爻", zhi: b.zhi, wx: b.wx, qin: b.qin,
                 notes: [], chongHe: true });
    });
  }
  return out;
}

/* ═══════════════ 作用鏈 ═══════════════ */

type Edge = { rel: "生" | "剋" | "沖" | "合"; actor: Actor; target: number };

/** 全盤作用邊：每個作用者對每個本爻的生／剋／沖／合。
 *  作用者不作用於自身本位（變爻對本位之回頭生剋沖合已由化象標記涵蓋）。 */
export function edgesOf(c: Chart, acts: Actor[] = actorsOf(c)): Edge[] {
  const out: Edge[] = [];
  for (const a of acts) {
    c.ben.forEach((t, j) => {
      if (a.pos === j) return;
      if (SHENG[a.wx] === t.wx) out.push({ rel: "生", actor: a, target: j });
      if (KE[a.wx] === t.wx) out.push({ rel: "剋", actor: a, target: j });
      if (!a.chongHe) return; // 暗動無沖合之力
      if (CHONG[a.zhi] === t.zhi) out.push({ rel: "沖", actor: a, target: j });
      if (HE6[a.zhi] === t.zhi) out.push({ rel: "合", actor: a, target: j });
    });
  }
  return out;
}

/** 沖中逢合／合後逢沖（2026-08-28 裁決，只論日辰，月建不論）：
 *  沖中逢合＝先受動爻沖剋，而後得日辰來合 → 一開始不順，終究能成。
 *  合後逢沖＝先得他爻生合，而後被日辰所沖 → 一開始順利，最終破敗。 */
export function chongHeTurn(c: Chart, i: number, edges: Edge[]): string | null {
  const e = c.ben[i];
  const dayZhi = c.ganzhi.day[1];
  const inbound = edges.filter((x) => x.target === i && x.actor.from !== "日辰");
  const hurt = inbound.some((x) => x.rel === "剋" || x.rel === "沖");
  const help = inbound.some((x) => x.rel === "生" || x.rel === "合");
  if (hurt && HE6[dayZhi] === e.zhi) return "沖中逢合——先受動爻沖剋、而後日辰來合，起初不順而終能成";
  if (help && CHONG[dayZhi] === e.zhi) return "合後逢沖——先得他爻生合、而後日辰來沖，起初順利而終破敗";
  return null;
}

/** 附加於【盤面】之後的動爻區塊。此區塊之判定凌駕盤面「動靜」欄。 */
export function dongyaoText(c: Chart): string {
  const acts = actorsOf(c);
  const edges = edgesOf(c, acts); // 必須共用同一份 acts：作用鏈按物件識別回查作用者
  const dayZhi = c.ganzhi.day[1];
  const nameOf = (j: number) => `${YAO_NAMES[j]}${c.ben[j].qin}${c.ben[j].zhi}${c.ben[j].wx}`;

  // ① 誰在動
  const rows = acts.filter((a) => a.from !== "日辰").map((a) => `・${label(a)}`);
  const still = c.ben
    .map((e, i) => {
      if (acts.some((a) => a.from === "本爻" && a.pos === i)) return null;
      const why = isRiPo(e.zhi, e.wx, c, c.moving[i])
        ? isPoJin(e.zhi, c) ? "日沖＋月破＝破盡" : "日沖而月令休囚＝日破"
        : "靜";
      return `${YAO_NAMES[i]}${e.qin}${e.zhi}（${why}）`;
    })
    .filter(Boolean);
  const bianRest = c.bian
    ? c.moving.map((mv, i) => (mv && !bianActs(c, i).active
        ? `${YAO_NAMES[i]}變爻${c.bian![i].zhi}（${bianActs(c, i).why}）` : null)).filter(Boolean)
    : [];

  // ② 作用鏈
  const chain = acts.map((a) => {
    const mine = edges.filter((x) => x.actor === a);
    if (!mine.length) return `${label(a)} → 卦中無所作用`;
    const grp = (["剋", "沖", "生", "合"] as const)
      .map((r) => {
        const t = mine.filter((x) => x.rel === r).map((x) => nameOf(x.target));
        return t.length ? `${r} ${t.join("、")}` : null;
      })
      .filter(Boolean).join("；");
    return `${label(a)} → ${grp}`;
  });

  // ③ 受剋受沖與救應
  const rescue = c.ben.map((e, i) => {
    const inbound = edges.filter((x) => x.target === i);
    const bad = inbound.filter((x) => x.rel === "剋" || x.rel === "沖");
    if (!bad.length) return null;
    const good = inbound.filter((x) => x.rel === "生" || x.rel === "合");
    const src = (xs: Edge[]) => xs.map((x) => `${x.actor.from === "日辰" ? "日辰" : YAO_NAMES[x.actor.pos] + (x.actor.from === "變爻" ? "變爻" : "")}${x.actor.zhi}之${x.rel}`).join("、");
    const turn = good.length
      ? `救應：${src(good)} → 受制而有生合來救，尚有轉機`
      : "救應：全盤無動爻、無日辰來生合 → 無救";
    // 同一作用者既剋（沖）又合：依「沖合大於生剋」，先論合絆、暫不受其剋
    const both = [...new Set(bad.map((x) => x.actor).filter((a) => good.some((g) => g.actor === a)))];
    const note = both.length
      ? `（${both.map((a) => (a.from === "日辰" ? "日辰" : YAO_NAMES[a.pos] + (a.from === "變爻" ? "變爻" : "")) + a.zhi).join("、")}對此爻既剋沖又相合，依沖合大於生剋，先論合絆、暫不受其剋）`
      : "";
    return `・${nameOf(i)}：受 ${src(bad)}。${turn}${note}`;
  }).filter(Boolean);

  // ④ 沖中逢合／合後逢沖
  const turns = c.ben.map((e, i) => {
    const t = chongHeTurn(c, i, edges);
    return t ? `・${nameOf(i)}：${t}` : null;
  }).filter(Boolean);

  return [
    `【動爻判定·排盤程式判定·直接採用】`,
    `本區塊之動靜判定**凌駕上表「動靜」欄**：上表只記老陽老陰之發動，本區塊列為「視同發動」之爻雖在上表標「靜」，論斷時一律以動爻論；本區塊未列者才是真靜爻。`,
    `日辰${c.ganzhi.day}——六爻主宰，作用為永久，不受卦中任何爻之生剋沖合。`,
    `能作用之爻：`,
    ...(rows.length ? rows : ["・無（六爻俱靜、無日辰入卦、無暗動）"]),
    ...(bianRest.length ? [`變爻不參戰：${bianRest.join("；")}`] : []),
    `不作用之爻：${still.length ? still.join("、") : "無"}`,
    ``,
    `【動爻作用鏈·先看誰動、再看生剋卡在哪一環】`,
    ...chain,
    ``,
    `【受剋受沖與救應】`,
    ...(rescue.length ? rescue : ["・全盤無爻受剋受沖"]),
    ...(turns.length ? [``, `【沖中逢合／合後逢沖】`, ...turns] : []),
    ``,
    `【動爻讀法補充】`,
    `・日辰入卦之爻最強，旺衰直接以旺論，不看月令休囚；**只有該地支本身得此旺，卦中同五行之其他地支不與焉**（例：戌臨日建，辰丑未不因此得旺）。`,
    `・暗動之爻有生剋而無沖合之力，故上列作用鏈中暗動者只出現生剋、不出現沖合。`,
    `・沖脫（動爻逢日沖）仍是動爻、仍作用，但主事情進行而後散；其變爻不論。`,
    `・變爻已回頭生剋本位者，作用盡於本位，不得再拿去與其他爻論生剋；未回頭生剋者才視同動爻參戰。`,
    acts.some((a) => a.from === "日辰")
      ? `・日辰${dayZhi}本體已列於作用鏈，其生剋沖合遍及全盤，不受卦中任何爻反制。`
      : `・日辰${dayZhi}已入卦，其本體之力併入該爻計算、不另列一行，論斷時勿再把日辰與該爻當成兩股力重複計次。`,
  ].join("\n");
}

/* ═══════════════ 自檢（dev 用；判定前提一破就報錯） ═══════════════ */

export function selfCheck(): string[] {
  const e: string[] = [];
  // 1. 暗動只取月令之旺的前提：六組相沖無一相生，且無自沖。
  for (const z of ZHI) {
    const o = CHONG[z], a = ZHI_WX[z], b = ZHI_WX[o];
    if (SHENG[a] === b || SHENG[b] === a) e.push(`相沖竟相生：${z}沖${o}——isAnDong 之旺取月令的前提已破`);
    if (z === o) e.push(`自沖：${z}`);
    if (CHONG[o] !== z) e.push(`沖不對稱：${z}→${o}→${CHONG[o]}`);
    if (HE6[HE6[z]] !== z) e.push(`合不對稱：${z}→${HE6[z]}→${HE6[HE6[z]]}`);
    if (HE6[z] === z) e.push(`自合：${z}`);
  }
  // 2. 日辰入卦與暗動、日破互斥（同支不可能相沖）。
  for (const z of ZHI) if (CHONG[z] === z) e.push(`日辰入卦與日沖可同時成立：${z}`);
  // 3. 六合對照：子丑 寅亥 卯戌 辰酉 巳申 午未
  const he: [string, string][] = [["子","丑"],["寅","亥"],["卯","戌"],["辰","酉"],["巳","申"],["午","未"]];
  for (const [x, y] of he) if (HE6[x] !== y) e.push(`六合錯：${x}應合${y}，得${HE6[x]}`);
  // 4. 相沖對照：子午 丑未 寅申 卯酉 辰戌 巳亥
  const ch: [string, string][] = [["子","午"],["丑","未"],["寅","申"],["卯","酉"],["辰","戌"],["巳","亥"]];
  for (const [x, y] of ch) if (CHONG[x] !== y) e.push(`相沖錯：${x}應沖${y}，得${CHONG[x]}`);
  // 5. 旺衰：春（寅卯月）木旺火相水休金囚土死；辰戌丑未月土旺
  const spring: [string, Wang][] = [["木","旺"],["火","相"],["水","休"],["金","囚"],["土","死"]];
  for (const [wx, want] of spring)
    if (monthWang(wx, "寅") !== want) e.push(`旺衰錯：寅月${wx}應${want}，得${monthWang(wx, "寅")}`);
  for (const z of ["辰","戌","丑","未"])
    if (monthWang("土", z) !== "旺") e.push(`旺衰錯：${z}月土應旺`);
  return e;
}

/** 送進模型的完整盤面＝core.ts 的排盤文字 ＋ 本檔的動爻區塊。
 *  所有解卦路徑（首解、追問、評卦、展開、日運）一律走這裡，不再直接用 chartText，
 *  免得又出現「某條路徑看得到動爻判定、某條看不到」的分歧。 */
export function chartTextFull(c: Chart, question: string): string {
  return `${chartText(c, question)}\n\n${dongyaoText(c)}`;
}
