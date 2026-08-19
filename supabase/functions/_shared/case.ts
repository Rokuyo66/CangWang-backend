// _shared/case.ts — 卦案投射：把「一個真實卦盤」投射成「一張案件地圖的初始狀態」。
//
// 純函數、零 AI、零隨機、零 I/O。同一個 Chart ＋ 同一份 CaseDef 必得同一個 CaseState。
// 只讀 core.ts 的 Chart，不改 core.ts（不觸發「改 core 三處同步」）。
//
// 設計裁決（2026-08-18）：
//   1. 卦不決定案件真相。真相由案件設計師預先寫死；卦只決定「玩家從哪切入、
//      哪一區敞開、關鍵線索的代價多大、誰幫誰擋、何時翻面」。
//   2. 方位一律取【卦宮八卦（後天方位）】，不取納甲地支方位。
//      案件主軸方位 = 卦宮；內三爻區方位 = 下卦；外三爻區方位 = 上卦。
//   3. 地圖六區直接綁六爻爻位，沿用傳統家宅占爻位取象，不另造一套空間系統。
//   4. 用神取法由案件設計師依「所問之事」指定，不為了遊戲效果攀親帶故：
//      問無名分之他人取應、問己身取世、問財物取妻財、問賊祟取官鬼……
//      單一案件內世應組合固定不是缺點，變化由旺衰生剋與飛伏承擔。
//   5. 旺衰、生剋、元忌神、飛伏一律進投射——不進不只是少了層次，是會判錯。
//
// 【流派】旺衰與空破墓伏全部依 rules.ts 第 33／25／26／34 行，不另立一套：
//   月令定旺相休囚死（同令旺、令生相、生令休、剋令囚、令剋死；辰戌丑未月土旺）
//   日辰力大：生剋沖合值。日沖旺靜爻＝暗動（有用），沖休囚爻＝日破
//   旬空分真假：日月其一旺相為假空（蓄勢待發），均休囚為真空（徹底無力）
//   入墓前提是該爻於日月休囚——旺相之爻不入墓
//   伏神除真空外一律判出伏，傾向可出；唯伏神同時受日、月、飛神所剋而無生扶才難出
//   原神生用神、忌神剋用神、仇神生忌剋原；忌神剋用而元神得氣則貪生忘剋通關
//
// ⚠ 本檔重列了 core.ts 未匯出的五行生剋／沖合墓／地支五行表。
//   selfCheck() 逐條反查，兩邊一旦漂移立即報錯。
//   正式併入 production 時應改為由 core.ts 匯出，移除本檔重列。

import {
  ZHI, YAO_NAMES, GUA_BY_UPPER, ALL_GUA_NAMES, guaName,
  huaJinTui, pickUsePos, sanheCheck, fuyinCheck, xunKong,
  type Chart,
} from "./core.ts";

/* ═══════════════ 卦理常數（與 core.ts 同源，見檔頭警告） ═══════════════ */

const TRIGRAM_BITS: Record<string, string> = {
  "111": "乾", "110": "兌", "101": "離", "100": "震",
  "011": "巽", "010": "坎", "001": "艮", "000": "坤",
};

// 後天八卦方位（裁決：方位一律走卦宮八卦，不走納甲地支）
const HOUTIAN_DIR: Record<string, string> = {
  乾: "西北", 坎: "北", 艮: "東北", 震: "東",
  巽: "東南", 離: "南", 坤: "西南", 兌: "西",
};

const ZHI_WX: Record<string, string> = {
  子: "水", 丑: "土", 寅: "木", 卯: "木", 辰: "土", 巳: "火",
  午: "火", 未: "土", 申: "金", 酉: "金", 戌: "土", 亥: "水",
};
// 相生：木火土金水木
const SHENG: Record<string, string> = { 木: "火", 火: "土", 土: "金", 金: "水", 水: "木" };
// 相剋：木剋土、土剋水、水剋火、火剋金、金剋木
const KE: Record<string, string> = { 木: "土", 土: "水", 水: "火", 火: "金", 金: "木" };

const CHONG: Record<string, string> = Object.fromEntries(
  ZHI.map((z, i) => [z, ZHI[(i + 6) % 12]]),
);
// 六合：子丑 寅亥 卯戌 辰酉 巳申 午未 → j = (1 - i) mod 12
const HE6: Record<string, string> = Object.fromEntries(
  ZHI.map((z, i) => [z, ZHI[((1 - i) % 12 + 12) % 12]]),
);
// 入墓：水墓辰、火墓戌、金墓丑、木墓未（辰戌丑未為土，土不入墓）
const MU: Record<string, string> = { 水: "辰", 火: "戌", 金: "丑", 木: "未" };

// 六神場域色彩：只給訊號，文案交給 AI 依此演繹
const BEAST_MOOD: Record<string, string> = {
  青龍: "喜慶·酒食·貴人", 朱雀: "口舌·文書·消息", 勾陳: "遲滯·田土·舊事",
  螣蛇: "怪異·驚恐·纏繞", 白虎: "傷病·血光·凶險", 玄武: "盜隱·暗昧·欺瞞",
};

// 爻位取象（傳統家宅占）。案件設計師據此配區域。
export const YAO_IMAGE = [
  "宅基·井·灶·地下·足", "宅·堂屋·廚房·內室", "門·床·臥房·兄弟",
  "戶·大門·外牆·近鄰", "道路·行人·官府·人口", "宗廟·屋頂·牆外·最高最遠",
];

/* ═══════════════ 型別 ═══════════════ */

export interface CaseRegionDef { pos: number; name: string; image: string }

export interface CaseDef {
  id: string;
  title: string;
  question: string;
  // 用神依所問之事定，不預設、不為遊戲效果攀親帶故：
  //   六親（父母／兄弟／官鬼／妻財／子孫）＝ 問與己有名分之人、或該六親所主之事物
  //   "應" ＝ 問無名分之他人（陌生人、對手、對方行蹤態度）
  //   "世" ＝ 問己身
  useQin: string;
  regions: CaseRegionDef[];
}

export type Wang = "旺" | "相" | "休" | "囚" | "死";

/** 關鍵線索的取得代價。卦只動這個，不動「線索是否存在」。 */
export type Access =
  | "noCase"     // 用神不上卦又無伏神 → 此卦不成案
  | "hidden"     // 伏藏、判可出伏 → 先處理飛神代表之事
  | "hiddenHard" // 伏藏且日月飛俱剋無扶 → 難出伏，本局幾乎挖不出
  | "void"       // 真空（日月均休囚）→ 徹底無力，須改日再問
  | "timed"      // 假空（日月其一旺相）→ 蓄勢待發，待出空填實
  | "sealed"     // 入墓（唯休囚之爻才入）→ 被關住，須沖開庫
  | "broken"     // 月破／日破 → 線索殘毀，要補
  | "stirring"   // 暗動（日沖旺靜爻）→ 表面未動，暗中已啟動
  | "contested"  // 忌神旺動剋用且無通關 → 有人正在毀線索，跟時間搶
  | "open"       // 用神有力，或元神旺動來生 → 直接可得
  | "normal";    // 平

export type Tempo = "urgent" | "normal" | "slow";
export type ShiYong = "用生世" | "用剋世" | "世生用" | "世剋用" | "比和";

export interface KeyState {
  pos: number | null;      // 關鍵線索所在區
  hidden: boolean;         // 用神伏藏
  flyPos: number | null;   // 飛神所在區
  chuFu: "易出" | "難出" | null;
  wang: Wang | null;       // 月令旺相休囚死
  dayActs: string[];       // 臨日建／日生／日剋／日沖／日合
  kong: "真空" | "假空" | null;
  mu: string | null;       // 入日墓／入月墓（旺相不入）
  po: "月破" | "日破" | null;
  poFatal: boolean;        // 月破是否構成「近乎無用」（限休囚靜爻）
  anDong: boolean;         // 暗動
  grade: "有力" | "平" | "無力";
}

export interface SupportState {
  yuanPos: number[];    // 元神（生用神）所在區 → 助力
  jiPos: number[];      // 忌神（剋用神）所在區 → 阻力
  chouPos: number[];    // 仇神（生忌剋元）所在區
  yuanActive: boolean;  // 元神發動（含暗動）
  jiActive: boolean;    // 忌神發動（含暗動）
  jiStrong: boolean;    // 忌神旺動
  tongGuan: boolean;    // 貪生忘剋：忌神剋用而元神得氣通關
}

export interface RegionState {
  pos: number; name: string; image: string;
  qin: string; zhi: string; wx: string;
  beast: string; mood: string;
  dir: string;
  roles: string[];  // 世／應／用神／飛神／元神／忌神／仇神
  moving: boolean;
  anDong: boolean;
  wang: Wang;
  flux: string[];
  tags: string[];
}

export interface CaseState {
  caseId: string;
  benName: string; bianName: string | null;
  palace: string; palaceDir: string; guaType: string;
  useQin: string;
  key: KeyState;
  support: SupportState;
  shiYong: ShiYong | null;
  access: Access;
  startPos: number; rivalPos: number;
  tempo: Tempo;
  turnTo: string | null; turnDir: string | null;
  omens: string[];
  regions: RegionState[];
  sig: { core: string; feel: string; full: string };
}

/* ═══════════════ 旺衰（rules.ts 第 33 行） ═══════════════ */

/** 月令定旺相休囚死：同令旺、令生相、生令休、剋令囚、令剋死。辰戌丑未月土旺。 */
export function monthWang(wx: string, monZhi: string): Wang {
  const m = ZHI_WX[monZhi];
  if (wx === m) return "旺";
  if (SHENG[m] === wx) return "相";
  if (SHENG[wx] === m) return "休";
  if (KE[wx] === m) return "囚";
  return "死"; // KE[m] === wx
}
const isWangXiang = (w: Wang) => w === "旺" || w === "相";

/** 日辰作用：值、生、剋、沖、合（日辰力大，不論旺相休囚） */
function dayActs(zhi: string, wx: string, dayZhi: string): string[] {
  const dWx = ZHI_WX[dayZhi];
  const a: string[] = [];
  if (zhi === dayZhi) a.push("臨日建");
  if (CHONG[dayZhi] === zhi) a.push("日沖");
  if (HE6[dayZhi] === zhi) a.push("日合");
  if (SHENG[dWx] === wx) a.push("日生");
  if (KE[dWx] === wx) a.push("日剋");
  return a;
}

/** 該爻是否「日月其一旺相」——真假空、入墓、暗動三處判定的共同前提 */
function vigorous(wx: string, zhi: string, c: Chart): boolean {
  const w = monthWang(wx, c.ganzhi.month[1]);
  if (isWangXiang(w)) return true;
  const da = dayActs(zhi, wx, c.ganzhi.day[1]);
  return da.includes("臨日建") || da.includes("日生");
}

/* ═══════════════ 逐爻事實標記 ═══════════════ */

function factTags(zhi: string, wx: string, c: Chart, moving: boolean): string[] {
  const dayZhi = c.ganzhi.day[1], monZhi = c.ganzhi.month[1];
  const kongSet = new Set(c.ganzhi.kong.split(""));
  const w = monthWang(wx, monZhi);
  const vig = vigorous(wx, zhi, c);
  const t: string[] = [w];

  if (kongSet.has(zhi)) t.push(vig ? "假空" : "真空");
  if (zhi === monZhi) t.push("臨月建");
  if (zhi === dayZhi) t.push("臨日建");
  if (CHONG[monZhi] === zhi) t.push("月破");
  // 日沖：旺相靜爻＝暗動（有用）；沖休囚靜爻＝日破。
  // 此處的旺相只看月令，理由見 isAnDong()：日辰在沖它，就不可能同時生扶它。
  if (CHONG[dayZhi] === zhi) t.push(moving ? "日沖" : isWangXiang(w) ? "暗動" : "日破");
  if (HE6[monZhi] === zhi) t.push("月合");
  if (HE6[dayZhi] === zhi) t.push("日合");
  // 入墓：唯休囚之爻才被關，旺相不入
  if (!isWangXiang(w)) {
    if (MU[wx] === monZhi) t.push("入月墓");
    if (MU[wx] === dayZhi) t.push("入日墓");
  }
  return t;
}

/** 暗動：日沖旺相之靜爻（rules.ts 第 33／37 行）。
 *
 *  「旺」取月令旺相二等，不併入日辰生扶——不是選擇從嚴，是日辰項在此結構上不可達：
 *  六組地支相沖（子午、丑未、寅申、卯酉、辰戌、巳亥）的五行關係只有相剋與比和兩種，
 *  沒有一組相生；同支更不可能相沖，故「臨日建」亦不成立。
 *  換言之日辰既然在沖它，就不可能同時生扶它，暗動的旺只能由月令決定。
 *
 *  真假空與入墓仍用 vigorous()（含日辰生扶）——那兩處沒有相沖的前提，
 *  rules.ts 明寫「日、月其一旺相」，日辰項在那裡是可達且必要的。 */
function isAnDong(zhi: string, wx: string, c: Chart, moving: boolean): boolean {
  if (moving) return false;
  if (CHONG[c.ganzhi.day[1]] !== zhi) return false;
  return isWangXiang(monthWang(wx, c.ganzhi.month[1]));
}

function fluxOf(c: Chart, i: number): string[] {
  if (!c.moving[i] || !c.bian) return [];
  const e = c.ben[i], b = c.bian[i];
  const kongSet = new Set(c.ganzhi.kong.split(""));
  const out: string[] = [];
  const jt = huaJinTui(e.zhi, b.zhi);
  if (jt) out.push(`化${jt}神`);
  if (SHENG[b.wx] === e.wx) out.push("回頭生");
  if (KE[b.wx] === e.wx) out.push("回頭剋");
  if (CHONG[e.zhi] === b.zhi) out.push("化回頭沖");
  if (HE6[e.zhi] === b.zhi) out.push("化合"); // 化合主絆住（rules.ts 第 34 行）
  if (MU[e.wx] === b.zhi && !isWangXiang(monthWang(e.wx, c.ganzhi.month[1]))) out.push("化墓");
  if (kongSet.has(b.zhi)) out.push("化空");
  return out;
}

/* ═══════════════ 用神狀態 ═══════════════ */

function keyStateOf(c: Chart, keyIdx: number | null, hidden: boolean,
                    fu: { zhi: string; wx: string; pos: number } | undefined): KeyState {
  if (keyIdx == null) {
    return { pos: null, hidden: false, flyPos: null, chuFu: null, wang: null,
             dayActs: [], kong: null, mu: null, po: null, anDong: false, grade: "無力" };
  }
  const dayZhi = c.ganzhi.day[1], monZhi = c.ganzhi.month[1];
  const kongSet = new Set(c.ganzhi.kong.split(""));
  const zhi = hidden ? fu!.zhi : c.ben[keyIdx].zhi;
  const wx = hidden ? fu!.wx : c.ben[keyIdx].wx;
  const w = monthWang(wx, monZhi);
  const da = dayActs(zhi, wx, dayZhi);
  const vig = vigorous(wx, zhi, c);
  const moving = !hidden && c.moving[keyIdx];

  const kong = kongSet.has(zhi) ? (vig ? "假空" : "真空") as const : null;
  let mu: string | null = null;
  if (!isWangXiang(w)) {
    if (MU[wx] === dayZhi) mu = "入日墓";
    else if (MU[wx] === monZhi) mu = "入月墓";
  }
  let po: "月破" | "日破" | null = null;
  if (CHONG[monZhi] === zhi) po = "月破";
  else if (!moving && CHONG[dayZhi] === zhi && !isWangXiang(w)) po = "日破";
  // 月破之「近乎無用」依 rules.ts 第 33 行限於休囚靜爻；旺相之爻或動爻逢月破不作廢論
  const poFatal = po === "日破" || (po === "月破" && !isWangXiang(w) && !moving);
  const anDong = !hidden && isAnDong(zhi, wx, c, moving);

  // 出伏判定（rules.ts 第 25 行）：傾向可出；唯伏神同時受日、月、飛神所剋而無生扶才難出
  let chuFu: "易出" | "難出" | null = null;
  if (hidden) {
    const fly = c.ben[fu!.pos];
    const dWx = ZHI_WX[dayZhi], mWx = ZHI_WX[monZhi];
    const helped = SHENG[dWx] === wx || SHENG[mWx] === wx || zhi === dayZhi || zhi === monZhi || isWangXiang(w);
    const flyWeak = kongSet.has(fly.zhi) || KE[dWx] === fly.wx || KE[mWx] === fly.wx;
    const flyFeeds = SHENG[fly.wx] === wx;
    const allKe = KE[dWx] === wx && KE[mWx] === wx && KE[fly.wx] === wx;
    chuFu = (allKe && !helped) ? "難出" : (helped || flyWeak || flyFeeds) ? "易出" : "易出";
  }

  const disabled = kong === "真空" || mu !== null || poFatal;
  const grade = disabled ? "無力" : (vig || anDong) ? "有力" : "平";
  return { pos: keyIdx + 1, hidden, flyPos: hidden ? fu!.pos + 1 : null, chuFu,
           wang: w, dayActs: da, kong, mu, po, poFatal, anDong, grade };
}

/* ═══════════════ 元神／忌神／仇神（rules.ts 第 26 行） ═══════════════
   以五行論，故世爻用神、應爻用神一體適用（同卦內六親與五行為一一對應）。 */

function supportOf(c: Chart, keyIdx: number | null, useWx: string | null): SupportState {
  const empty: SupportState = { yuanPos: [], jiPos: [], chouPos: [], yuanActive: false,
                                jiActive: false, jiStrong: false, tongGuan: false };
  if (keyIdx == null || !useWx) return empty;
  const yuanWx = Object.keys(SHENG).find((k) => SHENG[k] === useWx)!; // 生用神者
  const jiWx = Object.keys(KE).find((k) => KE[k] === useWx)!;         // 剋用神者
  const chouWx = Object.keys(SHENG).find((k) => SHENG[k] === jiWx)!;  // 生忌神者（＝剋元神者）

  const act = (i: number) => c.moving[i] || isAnDong(c.ben[i].zhi, c.ben[i].wx, c, c.moving[i]);
  const pick = (wx: string) => c.ben.map((e, i) => (e.wx === wx && i !== keyIdx ? i : -1)).filter((i) => i >= 0);
  const yuan = pick(yuanWx), ji = pick(jiWx), chou = pick(chouWx);

  const yuanActive = yuan.some(act);
  const jiActive = ji.some(act);
  const jiStrong = ji.some((i) => act(i) && isWangXiang(monthWang(c.ben[i].wx, c.ganzhi.month[1])));
  // 貪生忘剋：忌神剋用，但元神得氣居中通關
  const yuanQi = yuan.some((i) => isWangXiang(monthWang(c.ben[i].wx, c.ganzhi.month[1]))
    || vigorous(c.ben[i].wx, c.ben[i].zhi, c));
  return {
    yuanPos: yuan.map((i) => i + 1), jiPos: ji.map((i) => i + 1), chouPos: chou.map((i) => i + 1),
    yuanActive, jiActive, jiStrong, tongGuan: jiActive && yuanQi,
  };
}

/* ═══════════════ 代價判定 ═══════════════ */

function accessOf(k: KeyState, sup: SupportState): Access {
  if (k.pos == null) return "noCase";
  if (k.hidden) return k.chuFu === "難出" ? "hiddenHard" : "hidden";
  if (k.kong === "真空") return "void";
  if (k.mu) return "sealed";
  if (k.poFatal) return "broken";
  if (k.kong === "假空") return "timed";
  if (sup.jiStrong && !sup.tongGuan) return "contested";
  if (k.anDong) return "stirring";
  if (k.grade === "有力" || (sup.yuanActive && !sup.jiActive)) return "open";
  return "normal";
}

/* ═══════════════ 投射 ═══════════════ */

export function projectCase(c: Chart, def: CaseDef): CaseState {
  const loTri = TRIGRAM_BITS[c.benBits.slice(0, 3).join("")];
  const hiTri = TRIGRAM_BITS[c.benBits.slice(3, 6).join("")];

  // 用神：世／應為爻位直取（必上卦，結構上無伏神問題）；
  //       六親則先取本卦，不上卦轉伏神——飛伏機制在六親路徑上完整保留。
  const viaYing = def.useQin === "應", viaShi = def.useQin === "世";
  let keyIdx = viaYing ? c.ying - 1 : viaShi ? c.shi - 1 : pickUsePos(c, def.useQin);
  let hidden = false;
  const fu = keyIdx == null ? c.fushen.find((f) => f.qin === def.useQin) : undefined;
  if (keyIdx == null && fu) { hidden = true; keyIdx = fu.pos; }

  const useWx = keyIdx == null ? null : hidden ? fu!.wx : c.ben[keyIdx].wx;
  const key = keyStateOf(c, keyIdx, hidden, fu);
  const support = supportOf(c, keyIdx, useWx);
  const access = accessOf(key, support);

  // 世用生剋（用神即世時為比和）
  const shiIdx = c.shi - 1, yingIdx = c.ying - 1;
  const shiWx = c.ben[shiIdx].wx;
  let shiYong: ShiYong | null = null;
  if (useWx) {
    if (keyIdx === shiIdx || useWx === shiWx) shiYong = "比和";
    else if (SHENG[useWx] === shiWx) shiYong = "用生世";
    else if (KE[useWx] === shiWx) shiYong = "用剋世";
    else if (SHENG[shiWx] === useWx) shiYong = "世生用";
    else shiYong = "世剋用";
  }

  const defByPos = new Map(def.regions.map((r) => [r.pos, r]));
  const yuanSet = new Set(support.yuanPos), jiSet = new Set(support.jiPos), chouSet = new Set(support.chouPos);

  const regions: RegionState[] = c.ben.map((e, i) => {
    const rd = defByPos.get(i + 1);
    const roles: string[] = [];
    if (i === shiIdx) roles.push("世");
    if (i === yingIdx) roles.push("應");
    if (keyIdx === i) roles.push(hidden ? "用神伏此" : "用神");
    if (hidden && fu!.pos === i) roles.push("飛神");
    if (yuanSet.has(i + 1)) roles.push("元神");
    if (jiSet.has(i + 1)) roles.push("忌神");
    if (chouSet.has(i + 1)) roles.push("仇神");
    return {
      pos: i + 1,
      name: rd?.name ?? YAO_NAMES[i],
      image: rd?.image ?? YAO_IMAGE[i],
      qin: e.qin, zhi: e.zhi, wx: e.wx,
      beast: c.beasts[i], mood: BEAST_MOOD[c.beasts[i]],
      dir: HOUTIAN_DIR[i < 3 ? loTri : hiTri],
      roles,
      moving: c.moving[i],
      anDong: isAnDong(e.zhi, e.wx, c, c.moving[i]),
      wang: monthWang(e.wx, c.ganzhi.month[1]),
      flux: fluxOf(c, i),
      tags: factTags(e.zhi, e.wx, c, c.moving[i]),
    };
  });

  // 節奏：六沖散、六合聚、伏吟滯、多動急、忌神動急
  const omens: string[] = [];
  if (c.chong) omens.push("六沖");
  if (c.he) omens.push("六合");
  const fy = fuyinCheck(c); if (fy) omens.push("伏吟");
  const sh = sanheCheck(c);
  if (sh) omens.push(sh.includes("——成局") ? "三合成局" : sh.includes("待填實") ? "三合待填實" : "三合破局");
  if (support.tongGuan) omens.push("貪生忘剋通關");
  const movCount = c.moving.filter(Boolean).length;
  let tempo: Tempo = "normal";
  if (c.chong || movCount >= 3 || support.jiStrong) tempo = "urgent";
  else if (c.he || fy || (movCount === 0 && !regions.some((r) => r.anDong))) tempo = "slow";

  const bianHi = c.bian ? TRIGRAM_BITS[c.bianBits.slice(3, 6).join("")] : null;

  const st: CaseState = {
    caseId: def.id,
    benName: c.benName, bianName: c.bianName,
    palace: c.palace, palaceDir: HOUTIAN_DIR[c.palace], guaType: c.type,
    useQin: def.useQin,
    key, support, shiYong, access,
    startPos: c.shi, rivalPos: c.ying,
    tempo,
    turnTo: c.bianName, turnDir: bianHi ? HOUTIAN_DIR[bianHi] : null,
    omens, regions,
    sig: { core: "", feel: "", full: "" },
  };

  const movMask = c.moving.map((m) => (m ? 1 : 0)).join("");
  const jiMask = support.jiActive ? (support.jiStrong ? "忌旺動" : "忌動") : "忌靜";
  const yuanMask = support.yuanActive ? "元動" : "元靜";
  // core：線索在哪、多難拿、誰擋誰幫 —— 內容真正要撐的差異
  st.sig.core = [key.pos ?? "x", access, jiMask, yuanMask].join("/");
  // feel：玩家實際感受得到的佈局
  st.sig.feel = [
    key.pos ?? "x", access, key.grade, shiYong ?? "-",
    support.jiPos.join("") || "-", support.yuanPos.join("") || "-",
    st.startPos, st.rivalPos, movMask, tempo, st.palaceDir,
  ].join("|");
  // full：連六神、旺衰、變化細節都算
  st.sig.full = [
    st.sig.feel, c.benName, c.bianName ?? "-",
    regions.map((r) => `${r.beast}${r.wang}${r.flux.join("")}${r.tags.join("")}`).join(","),
  ].join("|");
  return st;
}

/* ═══════════════ 自檢：與 core.ts 及 rules.ts 流派對表 ═══════════════ */

function bitsOfName(name: string): number[] | null {
  for (let n = 0; n < 64; n++) {
    const bits = [0, 1, 2, 3, 4, 5].map((i) => (n >> i) & 1);
    if (guaName(bits) === name) return bits;
  }
  return null;
}

export function selfCheck(): string[] {
  const e: string[] = [];

  // 1. 八卦二進位表 vs core 的 GUA_BY_UPPER 分組
  for (const [upper, names] of Object.entries(GUA_BY_UPPER))
    for (const n of names) {
      const bits = bitsOfName(n);
      if (!bits) { e.push(`卦名反查失敗：${n}`); continue; }
      const mine = TRIGRAM_BITS[bits.slice(3, 6).join("")];
      if (mine !== upper) e.push(`上卦不符：${n} core=${upper} case=${mine}`);
    }
  if (ALL_GUA_NAMES.length !== 64) e.push(`卦名數不是 64：${ALL_GUA_NAMES.length}`);

  // 2. 沖／合／墓
  for (const z of ZHI) {
    if (CHONG[CHONG[z]] !== z) e.push(`沖不對稱：${z}`);
    if (HE6[HE6[z]] !== z) e.push(`合不對稱：${z}`);
    if (CHONG[z] !== ZHI[(ZHI.indexOf(z) + 6) % 12]) e.push(`沖錯：${z}`);
  }
  for (const [a, b] of [["子","丑"],["寅","亥"],["卯","戌"],["辰","酉"],["巳","申"],["午","未"]])
    if (HE6[a] !== b) e.push(`六合錯：${a}應合${b}，得${HE6[a]}`);
  for (const [wx, m] of [["水","辰"],["火","戌"],["金","丑"],["木","未"]])
    if (MU[wx] !== m) e.push(`墓錯：${wx}應墓${m}，得${MU[wx]}`);

  // 3. 生剋鐵則：木火土金水木；木剋土、土剋水、水剋火、火剋金、金剋木
  for (const [a, b] of [["木","火"],["火","土"],["土","金"],["金","水"],["水","木"]])
    if (SHENG[a] !== b) e.push(`相生錯：${a}生${SHENG[a]}，應生${b}`);
  for (const [a, b] of [["木","土"],["土","水"],["水","火"],["火","金"],["金","木"]])
    if (KE[a] !== b) e.push(`相剋錯：${a}剋${KE[a]}，應剋${b}`);

  // 4. 地支五行
  for (const [z, wx] of [["寅","木"],["卯","木"],["巳","火"],["午","火"],["申","金"],["酉","金"],
                          ["亥","水"],["子","水"],["辰","土"],["戌","土"],["丑","土"],["未","土"]])
    if (ZHI_WX[z] !== wx) e.push(`地支五行錯：${z}應${wx}，得${ZHI_WX[z]}`);

  // 5. 旺相休囚死：春（寅卯月）木旺、火相、水休、金囚、土死
  const spring: [string, Wang][] = [["木","旺"],["火","相"],["水","休"],["金","囚"],["土","死"]];
  for (const [wx, want] of spring) {
    const got = monthWang(wx, "寅");
    if (got !== want) e.push(`旺衰錯：寅月${wx}應${want}，得${got}`);
  }
  // 辰戌丑未月土旺
  for (const z of ["辰","戌","丑","未"])
    if (monthWang("土", z) !== "旺") e.push(`旺衰錯：${z}月土應旺，得${monthWang("土", z)}`);

  // 6. 元忌仇神鏈：以子孫為用 → 元神兄弟(木生火之類同理，此處以五行驗)
  //    用神火 → 元神木、忌神水、仇神金（金生水、金剋木）
  const yuan = Object.keys(SHENG).find((k) => SHENG[k] === "火");
  const ji = Object.keys(KE).find((k) => KE[k] === "火");
  const chou = Object.keys(SHENG).find((k) => SHENG[k] === ji);
  if (yuan !== "木") e.push(`元神錯：火之元神應為木，得${yuan}`);
  if (ji !== "水") e.push(`忌神錯：火之忌神應為水，得${ji}`);
  if (chou !== "金") e.push(`仇神錯：火之仇神應為金，得${chou}`);
  if (KE[chou!] !== yuan) e.push(`仇神須剋元神：${chou}剋${KE[chou!]}，應剋${yuan}`);

  // 7. 暗動判定的前提：六組相沖的五行關係只有相剋與比和，沒有一組相生。
  //    這是「暗動之旺只由月令決定、不併入日辰生扶」的依據；前提若破，判定就要重寫。
  for (const z of ZHI) {
    const o = CHONG[z], a = ZHI_WX[z], b = ZHI_WX[o];
    if (SHENG[a] === b || SHENG[b] === a)
      e.push(`相沖竟相生：${z}(${a}) 沖 ${o}(${b})——暗動判定的前提被破壞，isAnDong 須重寫`);
    if (z === o) e.push(`自沖：${z}`);
  }

  // 8. 旬空格式與八方位
  for (let i = 0; i < 60; i++) if (xunKong(i).length !== 2) e.push(`旬空格式錯 idx=${i}`);
  for (const t of ["乾","兌","離","震","巽","坎","艮","坤"]) if (!HOUTIAN_DIR[t]) e.push(`缺方位：${t}`);

  return e;
}
