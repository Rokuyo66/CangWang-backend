// _shared/jianghu.ts — 江湖尋訪：一趟怎麼走、走到哪個結局、亮了哪些成就。
//
// 格式見 dev/design/journal/JIANGHU-SCRIPT.md；稿紙（dev/design/journal/sheet.html）的「試走一趟」
// 與這裡是同一套規則，改一邊就要改另一邊（dev/jianghu-test.mts 拿乾為天的六條路線釘住）。
//
// 【為什麼結局在伺服器算】
// 客戶端只送「每個選擇點選了哪個 key」。數值、道具、旗標、結局都由這裡照劇本重演一次算出來——
// 客戶端送「我走到了哪個結局」的話，等於把第一次達成的靈石交給玩家自己填。
//
// 純函式、不碰資料庫：interpret 拿它來判，測試直接 import。

export type Choice = { key: string; label?: string; fx?: Record<string, number>; get?: string; req?: string; set?: string; to?: string;
  /** 要花的錢（財 s5）：身上不夠就選不了（畫面上照樣列出來、反灰），選了扣掉 */
  cost?: number };
/** 財＝盤纏。花費（cost）只看它 */
export const MONEY = "s5";
/** after：前路銜接（六六 2026-10-24）。填了幾個選項 key＝這一趟前面選過其中任一個才演這一幕，否則跳過、順著往下；空＝人人都演。
 *  寫在變數裡最常用：同一段變數，依前面怎麼選，開頭接不同的話。 */
export type Scene = { id?: string; text?: string; end?: boolean; choices?: Choice[]; after?: string[]; [k: string]: unknown };
export type Ending = {
  id: string; title: string; rare?: boolean; need?: Record<string, [number | null, number | null]>;
  flags?: string[]; not_flags?: string[];
  /** 這幾爻的變數這一趟都要演到（0＝初爻）；例：[5]＝上爻動、演了上爻的變數才可能走到 */
  moves?: number[];
  text?: string; insight?: string; npc_fate?: string; reward_lingshi?: number;
  player_title?: { label?: string; desc?: string; call_as?: string };
  hook?: { who?: string; ask?: string; memory?: string } | null;
};
export type Achievement = { id: string; name: string; desc?: string; kind: "ending" | "endings_all" | "changes_all" | "items_all" | "run";
  ending?: string; reward_lingshi?: number;
  /** kind="run"（一趟之內做到，六六 2026-10-22）：同一趟裡這些道具都帶著、數值都在範圍內（格式同結局的 need）；ending 有填的話也要是那個結局 */
  items?: string[]; need?: Record<string, [number | null, number | null]> };
export type Doc = {
  id: string; gua_no: number; gua: string; title: string;
  /** 一入場身上就有的數值（通常是盤纏：{ s5: 3 }＝觀裡給了三兩） */
  start?: Record<string, number>;
  npcs?: { id: string; name: string; desc?: string }[];
  opening?: { bg?: string; text?: string };
  identity?: { mode?: string; label?: string; reason?: string };
  outline?: { player_summary?: string };
  nodes: { title?: string; scenes: Scene[]; change?: { scenes: Scene[] } }[];
  endings: Ending[];
  achievement?: { name?: string; desc?: string; ending?: string };
  achievements?: Achievement[];
};

/** 這一趟走完的樣子 */
export type Walk = {
  ok: true; st: Record<string, number>; items: string[]; flags: string[];
  changes: number[];          // 實際演了變數的爻（0＝初爻）
  ending: Ending;
} | { ok: false; err: string };

const hasText = (s: Scene) => !!String(s.text ?? "").trim();
/** 前路銜接：沒填 after＝人人都演；填了＝前面選過其中一個才演 */
export const sceneOn = (s: Scene, picked: string[]) => !(s.after ?? []).length || (s.after ?? []).some((k) => picked.includes(k));
/** 這一爻動了、而且有變數幕，才會演變數 */
export const changePlays = (doc: Doc, i: number, moving: number[]) =>
  moving.includes(i) && (doc.nodes[i]?.change?.scenes ?? []).some(hasText);

/** 照劇本重演一趟。picks＝每個選擇點選的 key，依序。多送、少送、送了當下選不到的 key 都算錯。
 *  picks 也可以是一支函式（給測試：看當下能選的選項，回一個 key）。 */
export function walk(doc: Doc, moving: number[], picks: string[] | ((cs: Choice[]) => string)): Walk {
  const chooser = typeof picks === "function" ? picks : null, keys: string[] = chooser ? [] : picks as string[];
  const st: Record<string, number> = {}, items: string[] = [], flags: string[] = [], changes: number[] = [], picked: string[] = [];
  for (const [k, v] of Object.entries(doc.start ?? {})) st[k] = Number(v) || 0;
  let p = 0;
  const run = (list: Scene[]): string | null => {
    let si = 0, guard = 0;
    while (si >= 0 && si < list.length) {
      if (++guard > 500) return "劇本繞圈";
      const s = list[si];
      if (!sceneOn(s, picked)) { si++; continue; }   // 前路不合：這一幕不演，連它的「到此結束」也不算
      // 看得到＝有字、道具帶著；選得了＝看得到而且錢夠。一個都選不了就當這一幕沒有選項（不會卡死；稿紙檢查會提醒）
      const cs = (s.choices ?? []).filter((c) => String(c.label ?? "").trim() && (!c.req || items.includes(c.req))
        && (!c.cost || (st[MONEY] ?? 0) >= c.cost));
      if (cs.length) {
        if (chooser) keys.push(chooser(cs));
        const key = keys[p++];
        const c = cs.find((x) => x.key === key);
        if (!c) return `第 ${p} 個選擇對不上（${key ?? "沒送"}）`;
        picked.push(c.key);
        for (const [k, v] of Object.entries(c.fx ?? {})) st[k] = (st[k] ?? 0) + (Number(v) || 0);
        if (c.cost) st[MONEY] = (st[MONEY] ?? 0) - c.cost;
        if (c.get && !items.includes(c.get)) items.push(c.get);
        if (c.set && !flags.includes(c.set)) flags.push(c.set);
        if (c.to === "end") return null;
        if (c.to) { si = list.findIndex((x) => x.id === c.to); if (si < 0) return `跳到找不到的幕 ${c.to}`; }
        else si++;
        continue;
      }
      if (s.end) return null;
      si++;
    }
    return null;
  };
  for (let i = 0; i < 6; i++) {
    const n = doc.nodes[i];
    if (!n) return { ok: false, err: "劇本不足六節" };
    const e1 = run(n.scenes ?? []); if (e1) return { ok: false, err: e1 };
    if (changePlays(doc, i, moving)) {
      changes.push(i);
      const e2 = run(n.change!.scenes); if (e2) return { ok: false, err: e2 };
    }
  }
  if (p !== keys.length) return { ok: false, err: "送來的選擇比劇本多" };
  const ending = endingOf(doc, st, flags, changes);
  if (!ending) return { ok: false, err: "沒有任何結局符合（劇本少了保底）" };
  return { ok: true, st, items, flags, changes, ending };
}

/** 數值都在範圍內（結局的 need 與成就的 need 同一套） */
export const needOk = (need: Ending["need"], st: Record<string, number>) => Object.entries(need ?? {}).every(([k, r]) => {
  const [lo, hi] = Array.isArray(r) ? r : [null, null];
  return (lo == null || (st[k] ?? 0) >= lo) && (hi == null || (st[k] ?? 0) <= hi);
});

export function endingOf(doc: Doc, st: Record<string, number>, flags: string[], changes: number[] = []): Ending | null {
  const flagsOk = (en: Ending) => (en.flags ?? []).every((f) => flags.includes(f)) && !(en.not_flags ?? []).some((f) => flags.includes(f));
  const movesOk = (en: Ending) => (en.moves ?? []).every((i) => changes.includes(i));
  return doc.endings.find((en) => needOk(en.need, st) && flagsOk(en) && movesOk(en)) ?? null;
}

/** 成就清單。舊格式只有一個 achievement（綁結局），照樣認。 */
export function achievementsOf(doc: Doc): Achievement[] {
  if (Array.isArray(doc.achievements) && doc.achievements.length) return doc.achievements.filter((a) => a && a.id && a.name);
  const a = doc.achievement;
  return a && a.name && a.ending ? [{ id: "main", name: a.name, desc: a.desc ?? "", kind: "ending", ending: a.ending }] : [];
}

/** 劇本裡所有拿得到的道具 */
export const allItems = (doc: Doc) => [...new Set(doc.nodes.flatMap((n) =>
  [...(n.scenes ?? []), ...(n.change?.scenes ?? [])].flatMap((s) => (s.choices ?? []).map((c) => c.get).filter(Boolean) as string[])))];
/** 有變數幕的爻 */
export const changeNodes = (doc: Doc) => doc.nodes.map((_, i) => i).filter((i) => changePlays(doc, i, [i]));

/** 某位玩家這一卦已經亮了哪些成就。runs＝他走完的每一趟（st＝那一趟走完時的數值；舊紀錄沒有就當不符合數值條件）。 */
export function litAchievements(doc: Doc, runs: { ending_id: string; changes: number[]; items: string[]; st?: Record<string, number> | null }[]): string[] {
  const endings = new Set(runs.map((r) => r.ending_id));
  const seen = new Set(runs.flatMap((r) => r.changes ?? []));
  const all = allItems(doc), cn = changeNodes(doc);
  return achievementsOf(doc).filter((a) => {
    if (a.kind === "ending") return !!a.ending && endings.has(a.ending);
    if (a.kind === "endings_all") return doc.endings.length > 0 && doc.endings.every((e) => endings.has(e.id));
    if (a.kind === "changes_all") return cn.length > 0 && cn.every((i) => seen.has(i));
    if (a.kind === "items_all") return all.length > 0 && runs.some((r) => all.every((x) => (r.items ?? []).includes(x)));
    if (a.kind === "run") {
      const its = (a.items ?? []).filter(Boolean), hasNeed = Object.keys(a.need ?? {}).length > 0;
      if (!its.length && !hasNeed && !a.ending) return false;   // 什麼條件都沒填：不亮（稿紙檢查會提醒）
      return runs.some((r) => (!a.ending || r.ending_id === a.ending) && its.every((x) => (r.items ?? []).includes(x))
        && (!hasNeed || (!!r.st && needOk(a.need, r.st))));
    }
    return false;
  }).map((a) => a.id);
}

/** 下發給客戶端的劇本：只有演出要的東西。結局、成就條件、大綱、備註都不給——
 *  結局表下發等於開場就把六個結局劇透完，條件下發等於把攻略送過去。 */
export function clientDoc(doc: Doc) {
  const sc = (s: Scene) => {
    const o: Record<string, unknown> = {};
    for (const k of ["id", "bg", "place", "portrait", "who", "npc", "speaker", "me", "text", "end"]) if (s[k] !== undefined && s[k] !== "") o[k] = s[k];
    if (s.after?.length) o.after = s.after;   // 前路銜接：客戶端要照同一條跳過，選擇點才對得上
    if (s.choices?.length) o.choices = s.choices.filter((c) => String(c.label ?? "").trim())
      .map((c) => ({ key: c.key, label: c.label, ...((c as { hint?: string }).hint ? { hint: (c as { hint?: string }).hint } : {}), ...(c.to ? { to: c.to } : {}), ...(c.req ? { req: c.req } : {}), ...(c.get ? { get: c.get } : {}),
        // fx 下發：選了之後畫面上那一格數值要動（六六 2026-10-21）。選之前不顯示，結局表照樣不下發
        ...(c.fx && Object.keys(c.fx).length ? { fx: c.fx } : {}), ...(c.cost ? { cost: c.cost } : {}) }));
    return o;
  };
  return {
    gua_no: doc.gua_no, gua: doc.gua, title: doc.title, start: doc.start ?? {},
    npcs: (doc.npcs ?? []).map((n) => ({ id: n.id, name: n.name })),
    opening: doc.opening ?? {},
    nodes: doc.nodes.map((n) => ({ title: n.title ?? "", scenes: (n.scenes ?? []).map(sc), change: (n.change?.scenes ?? []).map(sc) })),
  };
}

/** 四項數值的名字（全江湖共用；jianghu_config.stats 可改，這是沒設時的預設） */
export const STATS_DEFAULT = [
  { k: "s1", name: "義" }, { k: "s2", name: "智" }, { k: "s3", name: "名" }, { k: "s4", name: "情" }, { k: "s5", name: "財" },
];

/** 動爻：lines（casts.lines，6／9 是動爻，lines[0]＝初爻）→ 動的爻號 */
export const movingOf = (lines: number[] | null | undefined) =>
  (lines ?? []).map((v, i) => (v === 6 || v === 9) ? i : -1).filter((i) => i >= 0);
/** 再走一趟：重搖動爻，每一爻四分之一（三枚錢：老陰八分之一＋老陽八分之一） */
export const rollMoving = (rand: () => number = Math.random) => [0, 1, 2, 3, 4, 5].filter(() => rand() < 0.25);

/** 化名：與稿紙同一支（日期＋卦＋玩家當種子，同一天固定） */
export const ALIAS_DEFAULT = {
  surnames: "沈陸顧蘇葉江林秦柳白溫謝韓聞裴燕晏程蕭鍾衛孟姜岳顏邵方傅杜唐莫洛",
  compound: "司馬 歐陽 上官 慕容 南宮 公孫 東方 令狐",
  given1: "青遠聽無明歸寒南疏知星清孤長雲寄若臨見懷照",
  given2: "崖舟雨咎微鶴川石塵衣硯霜燈岫野渡山言辭眠",
};
function rng(seed: string) {
  let x = 0; for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) | 0;
  return () => { x = (x * 1103515245 + 12345) | 0; return ((x >>> 16) & 0x7fff) / 0x8000; };
}
/** 玩家在入口自己骰的化名（六六 2026-10-22：要在外面就知道會用什麼名字進去）。
 *  前端用同一份字庫隨機組，送來的名字要真的是字庫組得出來的：姓（單姓或複姓）＋一字（given1 或 given2）或兩字（given1＋given2） */
export function aliasOk(name: string, cfg: Partial<typeof ALIAS_DEFAULT> = {}) {
  const c = { ...ALIAS_DEFAULT, ...cfg };
  const n = String(name ?? "").trim(); if (!n || n.length > 4) return false;
  const comp = c.compound.split(/\s+/).filter(Boolean), g1 = [...c.given1], g2 = [...c.given2];
  const rest = (r: string) => (r.length === 1 && (g1.includes(r) || g2.includes(r))) || (r.length === 2 && g1.includes(r[0]) && g2.includes(r[1]));
  const cp = comp.find((x) => n.startsWith(x));
  if (cp && rest(n.slice(cp.length))) return true;
  return [...c.surnames].includes(n[0]) && rest(n.slice(1));
}
export function alias(seed: string, cfg: Partial<typeof ALIAS_DEFAULT> = {}) {
  const c = { ...ALIAS_DEFAULT, ...cfg };
  const r = rng(seed), pick = <T>(s: T[]) => s[Math.floor(r() * s.length)];
  const comp = c.compound.split(/\s+/).filter(Boolean), sur = [...c.surnames];
  const xing = comp.length && r() < 0.1 ? pick(comp) : pick(sur);
  const a = pick([...c.given1]); let b = pick([...c.given2]); if (b === a) b = pick([...c.given2]);
  return xing + (r() < 0.2 ? b : a + b);
}
