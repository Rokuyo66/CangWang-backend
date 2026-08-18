// _shared/case.ts — 卦案投射：把「一個真實卦盤」投射成「一張案件地圖的初始狀態」。
//
// 純函數、零 AI、零隨機、零 I/O。同一個 Chart ＋ 同一份 CaseDef 必得同一個 CaseState。
// 只讀 core.ts 的 Chart，不改 core.ts（不觸發「改 core 三處同步」）。
//
// 設計裁決（2026-08-18）：
//   1. 卦不決定案件真相。真相由案件設計師預先寫死；卦只決定「玩家從哪切入、
//      哪一區敞開、關鍵線索的代價多大、何時翻面」。
//   2. 方位一律取【卦宮八卦（後天方位）】，不取納甲地支方位。
//      案件主軸方位 = 卦宮；內三爻區方位 = 下卦；外三爻區方位 = 上卦。
//   3. 地圖六區直接綁六爻爻位，沿用傳統家宅占爻位取象，不另造一套空間系統。
//
// ⚠ 本檔的五行生剋／沖合墓表與 core.ts 的 chartText() 同源。core.ts 未將其匯出，
//   故此處重列；selfCheck() 會逐條反查核對，兩邊一旦漂移立即報錯。
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

// 後天八卦方位（六六裁決：方位一律走卦宮八卦，不走納甲地支）
const HOUTIAN_DIR: Record<string, string> = {
  乾: "西北", 坎: "北", 艮: "東北", 震: "東",
  巽: "東南", 離: "南", 坤: "西南", 兌: "西",
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
// 入墓：水墓辰、火墓戌、金墓丑、木墓未（辰戌丑未土不入墓）
const MU: Record<string, string> = { 水: "辰", 火: "戌", 金: "丑", 木: "未" };

// 六神場域色彩：只給訊號，文案交給 AI 依此演繹
const BEAST_MOOD: Record<string, string> = {
  青龍: "喜慶·酒食·貴人",
  朱雀: "口舌·文書·消息",
  勾陳: "遲滯·田土·舊事",
  螣蛇: "怪異·驚恐·纏繞",
  白虎: "傷病·血光·凶險",
  玄武: "盜隱·暗昧·欺瞞",
};

// 爻位取象（傳統家宅占）。案件設計師據此配區域，寫在 CaseDef.regions[].image。
export const YAO_IMAGE = [
  "宅基·井·灶·地下·足",
  "宅·堂屋·廚房·內室",
  "門·床·臥房·兄弟",
  "戶·大門·外牆·近鄰",
  "道路·行人·官府·人口",
  "宗廟·屋頂·牆外·最高最遠",
];

/* ═══════════════ 型別 ═══════════════ */

export interface CaseRegionDef {
  pos: number;   // 1..6，對應爻位
  name: string;  // 區域名
  image: string; // 該區取象
}

export interface CaseDef {
  id: string;
  title: string;
  question: string; // 進案問句（固定，決定用神）
  // 用神依所問之事定，不預設：
  //   六親（父母／兄弟／官鬼／妻財／子孫）＝ 問與己有親屬名分之人事
  //   "應" ＝ 問無名分之他人（陌生人、對手、失物之獲得者）
  //   "世" ＝ 問己身
  useQin: string;
  regions: CaseRegionDef[];
}

/** 關鍵線索的取得代價。卦只動這個，不動「線索是否存在」。 */
export type Access =
  | "open"     // 用神臨值逢合 → 直接可得
  | "normal"   // 平 → 常規代價
  | "costly"   // 月破／日沖 → 線索殘缺，要補
  | "timed"    // 旬空 → 出空之時方得，有時間閘
  | "sealed"   // 入墓 → 被關住，須先沖開
  | "hidden"   // 伏藏 → 須先處理飛神代表之事才挖得出
  | "noCase";  // 用神不上卦且無伏 → 不成案

export type Tempo = "urgent" | "normal" | "slow";

export interface RegionState {
  pos: number; name: string; image: string;
  qin: string; zhi: string; wx: string;
  beast: string; mood: string;
  dir: string;      // 卦宮八卦方位
  roles: string[];  // 世／應／用神／飛神
  moving: boolean;
  flux: string[];   // 化進神／化退神／回頭生／回頭剋／化回頭沖／化空／化墓
  tags: string[];   // 空／臨月建／臨日建／月破／日沖／月合／日合／入月墓／入日墓
}

export interface CaseState {
  caseId: string;
  benName: string;
  bianName: string | null;
  palace: string;
  palaceDir: string;      // 案件主軸方位
  guaType: string;        // 本宮／一世…／遊魂／歸魂
  useQin: string;
  keyPos: number | null;  // 關鍵線索所在區（1..6）
  hidden: boolean;        // 用神伏藏
  flyPos: number | null;  // 飛神所在區
  access: Access;
  startPos: number;       // 世爻 → 玩家立足區
  rivalPos: number;       // 應爻 → 對手／目標區
  tempo: Tempo;
  turnTo: string | null;  // 變卦（案件後段翻面）
  turnDir: string | null; // 翻面後主軸方位
  omens: string[];        // 六沖／六合／伏吟／三合
  regions: RegionState[];
  sig: { core: string; feel: string; full: string };
}

/* ═══════════════ 投射 ═══════════════ */

function factTags(zhi: string, wx: string, c: Chart): string[] {
  const dayZhi = c.ganzhi.day[1], monZhi = c.ganzhi.month[1];
  const kongSet = new Set(c.ganzhi.kong.split(""));
  const t: string[] = [];
  if (kongSet.has(zhi)) t.push("空");
  if (zhi === monZhi) t.push("臨月建");
  if (zhi === dayZhi) t.push("臨日建");
  if (CHONG[monZhi] === zhi) t.push("月破");
  if (CHONG[dayZhi] === zhi) t.push("日沖");
  if (HE6[monZhi] === zhi) t.push("月合");
  if (HE6[dayZhi] === zhi) t.push("日合");
  if (MU[wx] === monZhi) t.push("入月墓");
  if (MU[wx] === dayZhi) t.push("入日墓");
  return t;
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
  if (MU[e.wx] === b.zhi) out.push("化墓");
  if (kongSet.has(b.zhi)) out.push("化空");
  return out;
}

/** 用神狀態 → 關鍵線索取得代價。順序即優先序。 */
function accessOf(keyIdx: number | null, tags: string[], hidden: boolean): Access {
  // 用神既不上卦、又無伏神：此卦不成案，遊戲應勸玩家改日再問，
  // 而不是硬指定一區——那就變成「劇情反過來決定卦」了。
  if (keyIdx == null) return "noCase";
  if (hidden) return "hidden";
  if (tags.includes("空")) return "timed";
  if (tags.includes("入日墓") || tags.includes("入月墓")) return "sealed";
  if (tags.includes("月破") || tags.includes("日沖")) return "costly";
  if (tags.some((t) => ["臨月建", "臨日建", "月合", "日合"].includes(t))) return "open";
  return "normal";
}

export function projectCase(c: Chart, def: CaseDef): CaseState {
  const loTri = TRIGRAM_BITS[c.benBits.slice(0, 3).join("")];
  const hiTri = TRIGRAM_BITS[c.benBits.slice(3, 6).join("")];

  // 用神：世／應為爻位直取，必上卦無伏神問題；六親則先取本卦，不上卦轉伏神
  const viaYing = def.useQin === "應", viaShi = def.useQin === "世";
  let keyIdx = viaYing ? c.ying - 1 : viaShi ? c.shi - 1 : pickUsePos(c, def.useQin);
  let hidden = false, flyIdx: number | null = null;
  const fu = keyIdx == null ? c.fushen.find((f) => f.qin === def.useQin) : undefined;
  if (keyIdx == null && fu) { hidden = true; keyIdx = fu.pos; flyIdx = fu.pos; }

  // 代價：伏藏時取伏神自身的旺衰（伏神能否透出），否則取用神本身
  const keyTags = keyIdx == null
    ? []
    : hidden
      ? factTags(fu!.zhi, fu!.wx, c)
      : factTags(c.ben[keyIdx].zhi, c.ben[keyIdx].wx, c);
  const access = accessOf(keyIdx, keyTags, hidden);

  const shiIdx = c.shi - 1, yingIdx = c.ying - 1;
  const defByPos = new Map(def.regions.map((r) => [r.pos, r]));

  const regions: RegionState[] = c.ben.map((e, i) => {
    const rd = defByPos.get(i + 1);
    const roles: string[] = [];
    if (i === shiIdx) roles.push("世");
    if (i === yingIdx) roles.push("應");
    if (keyIdx === i) roles.push(hidden ? "用神伏此" : "用神");
    if (flyIdx === i) roles.push("飛神");
    return {
      pos: i + 1,
      name: rd?.name ?? YAO_NAMES[i],
      image: rd?.image ?? YAO_IMAGE[i],
      qin: e.qin, zhi: e.zhi, wx: e.wx,
      beast: c.beasts[i], mood: BEAST_MOOD[c.beasts[i]],
      dir: HOUTIAN_DIR[i < 3 ? loTri : hiTri],
      roles,
      moving: c.moving[i],
      flux: fluxOf(c, i),
      tags: factTags(e.zhi, e.wx, c),
    };
  });

  // 節奏：六沖散、六合聚、伏吟滯、多動急
  const omens: string[] = [];
  if (c.chong) omens.push("六沖");
  if (c.he) omens.push("六合");
  const fy = fuyinCheck(c); if (fy) omens.push("伏吟");
  const sh = sanheCheck(c);
  if (sh) omens.push(sh.includes("——成局") ? "三合成局" : sh.includes("待填實") ? "三合待填實" : "三合破局");
  const movCount = c.moving.filter(Boolean).length;
  let tempo: Tempo = "normal";
  if (c.chong || movCount >= 3) tempo = "urgent";
  else if (c.he || fy || movCount === 0) tempo = "slow";

  const bianHi = c.bian ? TRIGRAM_BITS[c.bianBits.slice(3, 6).join("")] : null;

  const st: CaseState = {
    caseId: def.id,
    benName: c.benName, bianName: c.bianName,
    palace: c.palace, palaceDir: HOUTIAN_DIR[c.palace], guaType: c.type,
    useQin: def.useQin,
    keyPos: keyIdx == null ? null : keyIdx + 1,
    hidden, flyPos: flyIdx == null ? null : flyIdx + 1,
    access,
    startPos: c.shi, rivalPos: c.ying,
    tempo,
    turnTo: c.bianName,
    turnDir: bianHi ? HOUTIAN_DIR[bianHi] : null,
    omens,
    regions,
    sig: { core: "", feel: "", full: "" },
  };

  const movMask = c.moving.map((m) => (m ? 1 : 0)).join("");
  // core：關鍵線索在哪一區、好不好拿
  st.sig.core = `${st.keyPos ?? "x"}/${access}`;
  // feel：玩家實際感受得到差異的佈局
  st.sig.feel = [
    st.keyPos ?? "x", access, st.startPos, st.rivalPos, movMask, tempo, st.palaceDir,
  ].join("|");
  // full：連六神、方位、變化細節都算
  st.sig.full = [
    st.sig.feel, c.benName, c.bianName ?? "-",
    regions.map((r) => `${r.beast}${r.flux.join("")}${r.tags.join("")}`).join(","),
  ].join("|");
  return st;
}

/* ═══════════════ 自檢：與 core.ts 對表，防止重列漂移 ═══════════════ */

function bitsOfName(name: string): number[] | null {
  for (let n = 0; n < 64; n++) {
    const bits = [0, 1, 2, 3, 4, 5].map((i) => (n >> i) & 1);
    if (guaName(bits) === name) return bits;
  }
  return null;
}

export function selfCheck(): string[] {
  const errs: string[] = [];

  // 1. 八卦二進位表 vs core 的 GUA_BY_UPPER 分組（上卦名須一致）
  for (const [upper, names] of Object.entries(GUA_BY_UPPER)) {
    for (const n of names) {
      const bits = bitsOfName(n);
      if (!bits) { errs.push(`卦名反查失敗：${n}`); continue; }
      const mine = TRIGRAM_BITS[bits.slice(3, 6).join("")];
      if (mine !== upper) errs.push(`上卦不符：${n} core=${upper} case=${mine}`);
    }
  }
  if (ALL_GUA_NAMES.length !== 64) errs.push(`卦名數不是 64：${ALL_GUA_NAMES.length}`);

  // 2. 沖／合／墓
  for (const z of ZHI) {
    if (CHONG[CHONG[z]] !== z) errs.push(`沖不對稱：${z}`);
    if (HE6[HE6[z]] !== z) errs.push(`合不對稱：${z}`);
    if (CHONG[z] !== ZHI[(ZHI.indexOf(z) + 6) % 12]) errs.push(`沖錯：${z}`);
  }
  for (const [a, b] of [["子","丑"],["寅","亥"],["卯","戌"],["辰","酉"],["巳","申"],["午","未"]])
    if (HE6[a] !== b) errs.push(`六合錯：${a}應合${b}，得${HE6[a]}`);
  for (const [wx, m] of [["水","辰"],["火","戌"],["金","丑"],["木","未"]])
    if (MU[wx] !== m) errs.push(`墓錯：${wx}應墓${m}，得${MU[wx]}`);

  // 3. 生剋鐵則：木火土金水木；木剋土、土剋水、水剋火、火剋金、金剋木
  for (const [a, b] of [["木","火"],["火","土"],["土","金"],["金","水"],["水","木"]])
    if (SHENG[a] !== b) errs.push(`相生錯：${a}生${SHENG[a]}，應生${b}`);
  for (const [a, b] of [["木","土"],["土","水"],["水","火"],["火","金"],["金","木"]])
    if (KE[a] !== b) errs.push(`相剋錯：${a}剋${KE[a]}，應剋${b}`);

  // 4. 旬空格式
  for (let i = 0; i < 60; i++) if (xunKong(i).length !== 2) errs.push(`旬空格式錯 idx=${i}`);

  // 5. 後天八卦方位涵蓋 8 卦
  for (const t of ["乾","兌","離","震","巽","坎","艮","坤"])
    if (!HOUTIAN_DIR[t]) errs.push(`缺方位：${t}`);

  return errs;
}
