// _shared/yingqi.ts — 應期日曆：把「哪一天是什麼干支」由程式算好，附在盤面後面。
//
// 起因（dev/model-ab.mts，2026-10-08）：同一張盤、三個模型，應期的日期全算錯——
// 「10/19 己亥」（實為丙寅）、「亥月約 10 月下旬」（立冬 11/7 才入亥月）、還寫出不存在的「壬卯」。
// 卦理推到「應在亥日」多半是對的，錯在從亥日換成西曆那一步：那是查表，不是判斷，
// 語言模型做不準。所以表由這裡給，模型照抄（規則見 rules.ts【應期】）。
//
// 只列推應期最常用的三層：各地支的值日（日級小事）、月建（月級）、流年（年級）。
// 不列的（時辰、節氣中氣）真要用再加——每加一行都是每一卦的輸入 token。

import { ZHI, dayGZi, gzName, monthGZi, yearGZi, jieDay, inTable } from "./core.ts";

type Ymd = { y: number; m: number; d: number };
const WEEK = "日一二三四五六";
const DAY_MS = 86400_000;

const toUtc = (p: Ymd) => Date.UTC(p.y, p.m - 1, p.d);
const fromUtc = (t: number): Ymd => { const x = new Date(t); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const addDays = (p: Ymd, n: number) => fromUtc(toUtc(p) + n * DAY_MS);
const later = (a: Ymd, b: Ymd) => (toUtc(a) >= toUtc(b) ? a : b);
/** 同一年只寫月/日；跨年才帶年，免得每一格都多四個字 */
const md = (p: Ymd, base: Ymd) => (p.y === base.y ? `${p.m}/${p.d}` : `${p.y}/${p.m}/${p.d}`);
const wk = (p: Ymd) => WEEK[new Date(toUtc(p)).getUTCDay()];

/** 各地支自 from 起（含當天）的前 n 次值日。60 日一輪，每支至少出現 5 次，所以 60 日內必湊得滿兩次。 */
export function nextZhiDays(from: Ymd, n = 2, span = 60): Record<string, Ymd[]> {
  const out: Record<string, Ymd[]> = Object.fromEntries(ZHI.map((z) => [z, []]));
  for (let i = 0; i < span; i++) {
    const p = addDays(from, i);
    const z = ZHI[dayGZi(p.y, p.m, p.d) % 12];
    if (out[z].length < n) out[z].push(p);
  }
  return out;
}

/** from 所在的節氣月起算，往後 count 個月建（月以「節」交接，如寒露入戌月、立冬入亥月）。 */
export function nextMonths(from: Ymd, count = 6): { gz: string; start: Ymd; end: Ymd }[] {
  // 本月的起點：今天過了本西曆月的節 → 起點在本月；還沒過 → 在上個西曆月
  let y = from.y, m = from.m;
  if (from.d < jieDay(y, m)) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  const out: { gz: string; start: Ymd; end: Ymd }[] = [];
  for (let k = 0; k < count; k++) {
    if (!inTable(y) || !inTable(m === 12 ? y + 1 : y)) break;
    const start = { y, m, d: jieDay(y, m) };
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const end = addDays({ y: ny, m: nm, d: jieDay(ny, nm) }, -1);
    out.push({ gz: gzName(monthGZi(start.y, start.m, start.d)), start, end });
    y = ny; m = nm;
  }
  return out;
}

/** from 所在的流年起，往後 count 年（以立春為界）。 */
export function nextYears(from: Ymd, count = 3): { gz: string; start: Ymd; end: Ymd }[] {
  const { ey } = yearGZi(from.y, from.m, from.d);
  const out: { gz: string; start: Ymd; end: Ymd }[] = [];
  for (let k = 0; k < count; k++) {
    const y = ey + k;
    if (!inTable(y) || !inTable(y + 1)) break;
    const start = { y, m: 2, d: jieDay(y, 2) };
    out.push({ gz: gzName(((y - 4) % 60 + 60) % 60), start, end: addDays({ y: y + 1, m: 2, d: jieDay(y + 1, 2) }, -1) });
  }
  return out;
}

/** 盤面後面那一段。chartDate＝占期（旬空以它為準）；today＝現在（追問、評卦晚於占期時，
 *  已經過去的日子不列——列了模型就可能拿一個過去的日子當應期）。 */
export function yingqiText(chartDate: Ymd, today?: Ymd): string {
  if (!inTable(chartDate.y)) return "";
  const from = today ? later(today, chartDate) : chartDate;
  const fromIdx = dayGZi(from.y, from.m, from.d);
  const lines: string[] = [];
  lines.push("【應期日曆·排盤程式算定·日期一律照抄本表，不得自行推算干支與西曆的對應】");
  lines.push(`起算日：${from.y}/${from.m}/${from.d}（${wk(from)}）${gzName(fromIdx)}日${toUtc(from) > toUtc(chartDate) ? `（占期 ${chartDate.y}/${chartDate.m}/${chartDate.d}，已過的日子不列）` : ""}`);

  // 旬空出旬：以占期那一旬為準。下一旬起空亡之支不再空（填實則另看值日那一行）。
  const cIdx = dayGZi(chartDate.y, chartDate.m, chartDate.d);
  const xunEnd = addDays(chartDate, 9 - (cIdx % 10));
  const kong = ZHI[((cIdx - (cIdx % 10)) % 12 + 10) % 12] + ZHI[((cIdx - (cIdx % 10)) % 12 + 11) % 12];
  if (toUtc(xunEnd) >= toUtc(from)) lines.push(`旬空：${kong}（本旬至 ${md(xunEnd, from)} 止，${md(addDays(xunEnd, 1), from)} 起出旬）`);

  lines.push("各地支值日（自起算日起前兩次）：");
  const zd = nextZhiDays(from);
  for (const z of ZHI) {
    lines.push(`${z}：${zd[z].map((p) => `${md(p, from)}（${wk(p)}）${gzName(dayGZi(p.y, p.m, p.d))}`).join("、")}`);
  }
  const ms = nextMonths(from);
  if (ms.length) {
    lines.push("月建（以節交接）：" + ms.map((x) => `${x.gz[1]}月${x.gz} ${md(x.start, from)}–${md(x.end, from)}`).join("；"));
  }
  const ys = nextYears(from);
  if (ys.length) {
    lines.push("流年（以立春交接）：" + ys.map((x) => `${x.gz} ${x.start.y}/${x.start.m}/${x.start.d}–${x.end.y}/${x.end.m}/${x.end.d}`).join("；"));
  }
  return lines.join("\n");
}
