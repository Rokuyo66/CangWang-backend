// _shared/case-schema.ts — 案件檔的型別、驗證器與文本槽覆蓋分析。
//
// 案件檔是「設計師寫死的世界」：真相、地圖、NPC、線索、事件全在這裡，AI 不得增改。
// 卦盤透過 case.ts 的 projectCase() 投射出當局狀態，再從案件檔裡「選」對應的素材。
//
// 為什麼要 validator：一個案件的文本槽數量遠大於直覺——六區 × 十一種代價，
// 加上元神／忌神／世／應各自的表現。全填是浪費（有些組合機率極低），
// 憑感覺填會漏掉高機率組合。slotCoverage() 直接用真隨機起卦跑出實際機率，
// 告訴作者「哪些槽必填、按什麼順序填、填到哪裡可以收工」。
//
// 驗證器與覆蓋分析都是純函數；覆蓋分析用固定種子的 PRNG，同一份案件檔必得同一份報告。

import { buildChart, castCoins } from "./core.ts";
import { projectCase, type Access, type CaseDef } from "./case.ts";

/* ═══════════════ 型別 ═══════════════ */

export const ALL_ACCESS: Access[] = [
  "open", "normal", "timed", "void", "sealed", "broken",
  "contested", "stirring", "hidden", "hiddenHard", "noCase",
];
export const VALID_USE_QIN = ["父母", "兄弟", "官鬼", "妻財", "子孫", "世", "應"];
export const CHARACTER_IDS = ["daoshi_m", "daoshi_f", "lingshou"];

export interface ObjectFile {
  id: string;
  name: string;
  desc: string;        // 素材，不是最終文案；AI 依當局氛圍演繹
  clue?: string;       // 調查此物取得之線索 id
  needsItem?: string;  // 調查此物需先持有某道具（kind 為 item 的線索 id）
}

export interface RegionFile {
  pos: number;         // 1..6，對應爻位
  name: string;
  image: string;       // 爻位取象
  desc: string;        // 基礎場景素材
  objects: ObjectFile[];
  /** 此區為關鍵線索區時，各種取得代價下的表現。可留空，覆蓋分析會告訴你哪些必填。 */
  onKey: Partial<Record<Access, string>>;
  onYuan?: string;     // 此區為元神（助力）時
  onJi?: string;       // 此區為忌神（阻力）時
  onStart?: string;    // 此區為世爻（玩家立足）時
  onRival?: string;    // 此區為應爻（對手）時
}

export interface ClueFile {
  id: string;
  name: string;
  region: number;      // 所在區 1..6
  text: string;
  requires?: string[]; // 前置線索 id
  /** knowledge ＝ 你知道了什麼；item ＝ 你手上有什麼（可攜帶、可作工具、可出示）。
   *  兩者不分兩張表：差別只在能不能拿去撬、去開、去給人看，
   *  開兩套資料結構要作者維護兩份、validator 檢查兩份，換不到額外機制。 */
  kind: "knowledge" | "item";
}

/** NPC 會說的一句話。
 *
 *  「若無其他證據，就撬不開他的口」這件事靠 needs 做成真的機制——
 *  原本的 reactsTo 只會印一句「他的話停了半拍」，玩家出示證據拿不到任何新資訊，
 *  那是演出來的、不是機制。兩個欄位做同一件事只會讓作者維護兩份，故併為一個。 */
export interface NpcLine {
  /** 需先持有這些線索才會說出這句。省略＝一開口就說。 */
  needs?: string[];
  /** 說出來會取得的線索 id。省略＝只是反應或場面話，不給新資訊。 */
  clue?: string;
  /** 這句要傳達的內容——素材，不是最終台詞。
   *  正式版由 AI 依 voice 演繹；無 AI 的原型直接呈現。 */
  text: string;
}

export interface NpcFile {
  id: string;
  name: string;
  region: number;
  voice: string;       // 聲口提示，供 AI 演繹；不是台詞，不該直接印給玩家看
  says: NpcLine[];
}

export interface CompanionFile {
  id: string;          // daoshi_m／daoshi_f／lingshou
  regions: number[];   // 可自主搜索之區
  clues: string[];     // 可取得之線索 id（AI 不得創造清單外的線索）
  trigger: string;     // 自主搜索觸發條件
}

export interface CaseFile {
  id: string;
  title: string;
  version: number;
  question: string;    // 進案問句（固定，決定用神）
  useQin: string;      // 依所問之事取，見 case.ts CaseDef.useQin
  truth: string;       // 客觀真相：設計師寫死，AI 不得改寫、不得因卦象不同而變
  /** 事件全貌：寫給 AI 看的完整來龍去脈——誰在什麼時候做了什麼、動機、時間線、
   *  各人知道多少又隱瞞什麼。玩家永遠看不到這一段。
   *
   *  與 truth 分開存放，因為兩者的讀者不同、寫法也不同：
   *  truth 是結案時原文呈現給玩家的一段敘述，要好看、要留白；
   *  brief 是給 AI 對齊事實用的設定稿，要窮盡、要無趣、要把矛盾寫死。
   *  混在一起的話，玩家會在案件檔案裡讀到寫給 AI 的交代，
   *  而 AI 會因為素材不足自己補劇情——補出來的東西彼此矛盾。 */
  brief?: string;
  entryHour: number | null;  // 固定進案時辰 0..23（難度旋鈕）；null = 依玩家當下時間
  /** 真空／難出伏局（關鍵線索本局取不到）的處置：
   *  allow = 允許白跑，留下案件檔案與卦例紀錄，下次進案有加成
   *  retry = 直接勸退重來，不消耗次數
   *  裁決（六六 2026-08-19）：一律 allow。理由是白跑不等於白玩——
   *  同一張地圖在不同卦下對話與遭遇都不一樣，沒找到人那一趟本身就是一種結果。
   *  欄位保留，個別案件若要改判 retry 仍可覆寫。 */
  voidPolicy: "allow" | "retry";
  regions: RegionFile[];
  npcs: NpcFile[];
  clues: ClueFile[];
  companions: CompanionFile[];
}

/** 案件檔 → 投射用的精簡定義 */
export function toCaseDef(cf: CaseFile): CaseDef {
  return {
    id: cf.id, title: cf.title, question: cf.question, useQin: cf.useQin,
    regions: cf.regions.map((r) => ({ pos: r.pos, name: r.name, image: r.image })),
  };
}

/* ═══════════════ 結構驗證（純函數） ═══════════════ */

export function validateCase(cf: CaseFile): string[] {
  const e: string[] = [];
  const push = (m: string) => e.push(m);

  if (!cf.id) push("缺 id");
  if (!cf.title) push("缺 title");
  if (!cf.question) push("缺 question（進案問句）");
  if (!cf.truth?.trim()) push("缺 truth（客觀真相）——沒有寫死的真相，AI 就會自己編");
  if (!VALID_USE_QIN.includes(cf.useQin))
    push(`useQin「${cf.useQin}」不合法，須為 ${VALID_USE_QIN.join("／")}`);
  if (cf.entryHour != null && (cf.entryHour < 0 || cf.entryHour > 23))
    push(`entryHour 須為 0..23 或 null，得 ${cf.entryHour}`);
  if (cf.voidPolicy !== "allow" && cf.voidPolicy !== "retry")
    push(`voidPolicy 須為 allow／retry，得 ${cf.voidPolicy}`);

  // 區域：恰好 pos 1..6 各一
  const posSeen = new Map<number, number>();
  for (const r of cf.regions) posSeen.set(r.pos, (posSeen.get(r.pos) ?? 0) + 1);
  for (let p = 1; p <= 6; p++) {
    const n = posSeen.get(p) ?? 0;
    if (n === 0) push(`缺第 ${p} 區（地圖六區綁六爻爻位，不可缺）`);
    if (n > 1) push(`第 ${p} 區重複 ${n} 次`);
  }
  for (const r of cf.regions) {
    if (r.pos < 1 || r.pos > 6) push(`區域 pos 越界：${r.pos}`);
    if (!r.name) push(`第 ${r.pos} 區缺 name`);
    if (!r.desc?.trim()) push(`第 ${r.pos} 區缺 desc（基礎場景素材）`);
    for (const k of Object.keys(r.onKey)) {
      if (!ALL_ACCESS.includes(k as Access)) push(`第 ${r.pos} 區 onKey 有未知代價「${k}」`);
      if (!r.onKey[k as Access]?.trim()) push(`第 ${r.pos} 區 onKey.${k} 是空字串`);
    }
  }

  // id 唯一性
  const dup = (label: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const i of ids) { if (seen.has(i)) push(`${label} id 重複：${i}`); seen.add(i); }
  };
  const objIds = cf.regions.flatMap((r) => r.objects.map((o) => o.id));
  dup("物件", objIds);
  dup("線索", cf.clues.map((c) => c.id));
  dup("NPC", cf.npcs.map((n) => n.id));
  dup("同行角色", cf.companions.map((c) => c.id));

  const clueIds = new Set(cf.clues.map((c) => c.id));

  const byId = new Map(cf.clues.map((c) => [c.id, c]));
  const itemIds = new Set(cf.clues.filter((c) => c.kind === "item").map((c) => c.id));

  // 物件指向的線索與道具須存在
  for (const r of cf.regions)
    for (const o of r.objects) {
      if (!o.desc?.trim()) push(`物件 ${o.id} 缺 desc`);
      if (o.clue && !clueIds.has(o.clue)) push(`物件 ${o.id} 指向不存在的線索 ${o.clue}`);
      if (o.needsItem) {
        if (!clueIds.has(o.needsItem)) push(`物件 ${o.id} 需要不存在的道具 ${o.needsItem}`);
        else if (!itemIds.has(o.needsItem))
          push(`物件 ${o.id} 的 needsItem 指向 ${o.needsItem}，但那是 knowledge 不是 item——知識撬不開門`);
      }
    }

  // 線索
  for (const c of cf.clues) {
    if (c.region < 1 || c.region > 6) push(`線索 ${c.id} 的 region 越界：${c.region}`);
    if (!c.text?.trim()) push(`線索 ${c.id} 缺 text`);
    if (c.kind !== "knowledge" && c.kind !== "item")
      push(`線索 ${c.id} 的 kind 須為 knowledge／item，得 ${c.kind}`);
    for (const req of c.requires ?? [])
      if (!clueIds.has(req)) push(`線索 ${c.id} 的前置 ${req} 不存在`);
  }

  // 依賴成環 → 死鎖，玩家永遠拿不到。
  // 依賴 ＝ 前置線索 ∪ 取得途徑所需的道具。一條線索若有多個取得途徑，
  // 只要其中一條不需道具就不算被擋，故取各途徑所需道具的交集。
  const sourceDeps = (id: string): Set<string> => {
    const viaCompanion = cf.companions.some((c) => c.clues.includes(id));
    if (viaCompanion) return new Set(); // 角色自主搜索不需前置

    // 每個取得途徑各自的前置：物件看 needsItem，NPC 看那句話的 needs
    const perSource: Set<string>[] = [];
    for (const r of cf.regions)
      for (const o of r.objects)
        if (o.clue === id) perSource.push(new Set(o.needsItem ? [o.needsItem] : []));
    for (const n of cf.npcs)
      for (const l of n.says ?? [])
        if (l.clue === id) perSource.push(new Set(l.needs ?? []));

    if (!perSource.length) return new Set();
    // 多個途徑只要其中一條不需前置就不算被擋，故取交集
    let inter: Set<string> | null = null;
    for (const d of perSource)
      inter = inter == null ? d : new Set([...inter].filter((x) => d.has(x)));
    return inter ?? new Set();
  };
  const depsOf = (id: string): string[] =>
    [...new Set([...(byId.get(id)?.requires ?? []), ...sourceDeps(id)])].filter((x) => byId.has(x));

  const state = new Map<string, 0 | 1 | 2>();
  const walk = (id: string, path: string[]): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) { push(`線索依賴成環（玩家永遠解不開）：${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const dep of depsOf(id)) walk(dep, [...path, id]);
    state.set(id, 2);
  };
  for (const c of cf.clues) walk(c.id, []);

  // 孤兒線索：沒有任何物件、同行角色能取得
  const reachable = new Set<string>([
    ...cf.regions.flatMap((r) => r.objects.map((o) => o.clue).filter(Boolean) as string[]),
    ...cf.companions.flatMap((c) => c.clues),
    ...cf.npcs.flatMap((n) => (n.says ?? []).map((l) => l.clue).filter(Boolean) as string[]),
  ]);
  for (const c of cf.clues)
    if (!reachable.has(c.id))
      push(`線索 ${c.id}「${c.name}」無任何取得途徑（沒有物件、沒有角色、也沒有 NPC 會說）`);

  // NPC
  for (const n of cf.npcs) {
    if (n.region < 1 || n.region > 6) push(`NPC ${n.id} 的 region 越界：${n.region}`);
    if (!n.voice?.trim()) push(`NPC ${n.id} 缺 voice（聲口提示）`);
    if (!Array.isArray(n.says) || !n.says.length)
      push(`NPC ${n.id} 沒有任何 says——一個開口說不出話的人，玩家攀談只會得到空氣`);
    (n.says ?? []).forEach((l, i) => {
      const at = `NPC ${n.id} 第 ${i + 1} 句`;
      if (!l.text?.trim()) push(`${at}缺 text`);
      if (l.clue && !clueIds.has(l.clue)) push(`${at}指向不存在的線索 ${l.clue}`);
      for (const r of l.needs ?? [])
        if (!clueIds.has(r)) push(`${at}的 needs 指向不存在的線索 ${r}`);
      if (l.clue && (l.needs ?? []).includes(l.clue))
        push(`${at}要先持有 ${l.clue} 才肯說出 ${l.clue}——自己擋自己`);
    });
  }

  // 同行角色
  for (const c of cf.companions) {
    if (!CHARACTER_IDS.includes(c.id))
      push(`同行角色 id「${c.id}」不合法，須為 ${CHARACTER_IDS.join("／")}`);
    for (const p of c.regions) if (p < 1 || p > 6) push(`同行角色 ${c.id} 可搜索區越界：${p}`);
    for (const cl of c.clues) {
      if (!clueIds.has(cl)) push(`同行角色 ${c.id} 可取得不存在的線索 ${cl}`);
      else {
        const region = byId.get(cl)!.region;
        if (!c.regions.includes(region))
          push(`同行角色 ${c.id} 可取得線索 ${cl}，但該線索在第 ${region} 區而角色搜索不到那裡`);
      }
    }
    if (!c.trigger?.trim()) push(`同行角色 ${c.id} 缺 trigger（自主搜索觸發條件）`);
  }

  return e;
}

/* ═══════════════ 文本槽覆蓋分析 ═══════════════ */

export interface SlotNeed {
  pos: number;
  access: Access;
  prob: number;      // 此組合在真隨機起卦下的實際機率
  filled: boolean;
}

export interface CoverageReport {
  samples: number;
  needs: SlotNeed[];        // 依機率由高至低
  filledShare: number;      // 已填之槽合計覆蓋多少比例的局
  missingShare: number;     // 未填之槽合計漏掉多少比例的局
  roleShare: {              // 元神／忌神／世／應 各區出現機率
    yuan: number[]; ji: number[]; start: number[]; rival: number[];
  };
}

/** 固定種子 PRNG：同一份案件檔必得同一份報告，覆蓋數字才可以拿來追蹤進度 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function slotCoverage(cf: CaseFile, samples = 20000, seed = 20260818): CoverageReport {
  const rng = mulberry32(seed);
  const def = toCaseDef(cf);
  const counts = new Map<string, number>();
  const yuan = [0, 0, 0, 0, 0, 0], ji = [0, 0, 0, 0, 0, 0];
  const start = [0, 0, 0, 0, 0, 0], rival = [0, 0, 0, 0, 0, 0];

  for (let i = 0; i < samples; i++) {
    const { lines } = castCoins(rng);
    // 日期取樣：entryHour 固定時辰仍需跨月日，否則旺衰分佈會被單日鎖死
    const y = 2026;
    const m = 1 + Math.floor(rng() * 12);
    const d = 1 + Math.floor(rng() * 28);
    const hour = cf.entryHour ?? Math.floor(rng() * 24);
    const st = projectCase(buildChart(lines, y, m, d, hour), def);
    if (st.key.pos != null) {
      const k = `${st.key.pos}|${st.access}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const p of st.support.yuanPos) yuan[p - 1]++;
    for (const p of st.support.jiPos) ji[p - 1]++;
    start[st.startPos - 1]++;
    rival[st.rivalPos - 1]++;
  }

  const byPos = new Map(cf.regions.map((r) => [r.pos, r]));
  const needs: SlotNeed[] = [];
  for (const [k, n] of counts) {
    const [posStr, access] = k.split("|");
    const pos = Number(posStr);
    needs.push({
      pos, access: access as Access, prob: n / samples,
      filled: Boolean(byPos.get(pos)?.onKey[access as Access]?.trim()),
    });
  }
  needs.sort((a, b) => b.prob - a.prob);

  const filledShare = needs.filter((n) => n.filled).reduce((s, n) => s + n.prob, 0);
  return {
    samples, needs, filledShare, missingShare: 1 - filledShare,
    roleShare: {
      yuan: yuan.map((v) => v / samples), ji: ji.map((v) => v / samples),
      start: start.map((v) => v / samples), rival: rival.map((v) => v / samples),
    },
  };
}
