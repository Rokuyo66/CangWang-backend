// _shared/core.ts — 排盤核心（自已驗證之 core.js 移植；干支對 sxtwl 72 例全過）
export const GAN = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
export const ZHI = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const ZHI_WX: Record<string,string> = {子:"水",丑:"土",寅:"木",卯:"木",辰:"土",巳:"火",午:"火",未:"土",申:"金",酉:"金",戌:"土",亥:"水"};
const JIE_TABLE = "656566788877646566788987646566888988656666888988656556788877646566788887646566888988646566888988655556778877546566788887646566888988646566888988655556778877546566788887646566888987646566888988655556778877546566788887646566788987646566888988655556777877546566788877646566788987646566888988655556777877546566788877646566788987646566888988655555777877546566788877646566788987646566888988655555777877546556788877646566788987646566888988655455777877546556778877646566788887646566888988655455777877546556778877646566788887646566888988645455777877545556778877546566788887646566788987645455777877545556777877546566788887646566788987645455777877545556777877546566788877646566788987645455777877545555777877546566788877646566788987645455777877545555777877546566788877646566788987645455777877545555777877546556778877646566788987645455777877545455777877546556778877646566788887645455777877545455777877546556778877646566788887645455777877535455777877545556778877546566788887645455677877535455777877545556777877546566788887645455677876535455777877545555777877546566788877645455677876535455777877545555777877546566788877645455677876535455777877545555777877546556778877645455677876535455777877545555777877546556778877645455677876535455777877545455777877546556778877645455677776535455777877545455777877546556778877645455677776535455677877535455777877545556777877545455677776535455677877535455777877545555777877545455677776535455677876535455777877545555777877"; // 1940–2059 每年12節之日（程式注入，勿手改）
const JIE_BASE = 1940;
export const inTable = (y: number) => y >= JIE_BASE && y < JIE_BASE + 120;
const jieDay = (y: number, m: number) => +JIE_TABLE[(y - JIE_BASE) * 12 + (m - 1)];

function jdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}
export const dayGZi = (y: number, m: number, d: number) => ((jdn(y, m, d) + 49) % 60 + 60) % 60;
export const gzName = (i: number) => GAN[i % 10] + ZHI[i % 12];

export function yearGZi(y: number, m: number, d: number) {
  let ey = y;
  if (m < 2 || (m === 2 && d < jieDay(y, 2))) ey = y - 1;
  return { idx: ((ey - 4) % 60 + 60) % 60, ey };
}
export function monthGZi(y: number, m: number, d: number): number {
  let jm = m;
  if (d < jieDay(y, m)) jm = m - 1;
  if (jm === 0) jm = 12;
  const zhiIdx = jm % 12; // 1月小寒→丑(1)…12月大雪→子(0)
  const ey = yearGZi(y, m, d).ey;
  const yGan = ((ey - 4) % 10 + 10) % 10;
  const firstGan = [2, 4, 6, 8, 0][yGan % 5];
  const mGan = (firstGan + ((zhiIdx - 2 + 12) % 12)) % 10;
  for (let i = 0; i < 60; i++) if (i % 10 === mGan && i % 12 === zhiIdx) return i;
  return 0;
}
export function hourGZi(dayGanIdx: number, hour: number): number {
  const hZhi = Math.floor(((hour + 1) % 24) / 2);
  const firstGan = [0, 2, 4, 6, 8][dayGanIdx % 5];
  const g = (firstGan + hZhi) % 10;
  for (let i = 0; i < 60; i++) if (i % 10 === g && i % 12 === hZhi) return i;
  return 0;
}
export function xunKong(dayIdx: number): string {
  const head = dayIdx - (dayIdx % 10);
  return ZHI[(head % 12 + 10) % 12] + ZHI[(head % 12 + 11) % 12];
}

const TRIGRAMS: Record<string,string> = { "111":"乾","110":"兌","101":"離","100":"震","011":"巽","010":"坎","001":"艮","000":"坤" };
const PALACE_WX: Record<string,string> = {乾:"金",兌:"金",離:"火",震:"木",巽:"木",坎:"水",艮:"土",坤:"土"};
const NAJIA: Record<string,{g:[string,string],z:[string[],string[]]}> = {
  乾:{g:["甲","壬"],z:[["子","寅","辰"],["午","申","戌"]]},
  坎:{g:["戊","戊"],z:[["寅","辰","午"],["申","戌","子"]]},
  艮:{g:["丙","丙"],z:[["辰","午","申"],["戌","子","寅"]]},
  震:{g:["庚","庚"],z:[["子","寅","辰"],["午","申","戌"]]},
  巽:{g:["辛","辛"],z:[["丑","亥","酉"],["未","巳","卯"]]},
  離:{g:["己","己"],z:[["卯","丑","亥"],["酉","未","巳"]]},
  坤:{g:["乙","癸"],z:[["未","巳","卯"],["丑","亥","酉"]]},
  兌:{g:["丁","丁"],z:[["巳","卯","丑"],["亥","酉","未"]]},
};
const GUA_NAMES: Record<string,string> = {
  "乾乾":"乾為天","乾兌":"天澤履","乾離":"天火同人","乾震":"天雷無妄","乾巽":"天風姤","乾坎":"天水訟","乾艮":"天山遯","乾坤":"天地否",
  "兌乾":"澤天夬","兌兌":"兌為澤","兌離":"澤火革","兌震":"澤雷隨","兌巽":"澤風大過","兌坎":"澤水困","兌艮":"澤山咸","兌坤":"澤地萃",
  "離乾":"火天大有","離兌":"火澤睽","離離":"離為火","離震":"火雷噬嗑","離巽":"火風鼎","離坎":"火水未濟","離艮":"火山旅","離坤":"火地晉",
  "震乾":"雷天大壯","震兌":"雷澤歸妹","震離":"雷火豐","震震":"震為雷","震巽":"雷風恆","震坎":"雷水解","震艮":"雷山小過","震坤":"雷地豫",
  "巽乾":"風天小畜","巽兌":"風澤中孚","巽離":"風火家人","巽震":"風雷益","巽巽":"巽為風","巽坎":"風水渙","巽艮":"風山漸","巽坤":"風地觀",
  "坎乾":"水天需","坎兌":"水澤節","坎離":"水火既濟","坎震":"水雷屯","坎巽":"水風井","坎坎":"坎為水","坎艮":"水山蹇","坎坤":"水地比",
  "艮乾":"山天大畜","艮兌":"山澤損","艮離":"山火賁","艮震":"山雷頤","艮巽":"山風蠱","艮坎":"山水蒙","艮艮":"艮為山","艮坤":"山地剝",
  "坤乾":"地天泰","坤兌":"地澤臨","坤離":"地火明夷","坤震":"地雷復","坤巽":"地風升","坤坎":"地水師","坤艮":"地山謙","坤坤":"坤為地",
};
const LIUCHONG = new Set(["乾為天","兌為澤","離為火","震為雷","巽為風","坎為水","艮為山","坤為地","天雷無妄","雷天大壯"]);
const LIUHE = new Set(["地天泰","雷地豫","水澤節","火山旅","天地否","澤水困","山火賁","地雷復"]);

export const guaName = (bits: number[]) =>
  GUA_NAMES[TRIGRAMS[bits.slice(3,6).join("")] + TRIGRAMS[bits.slice(0,3).join("")]];

// 全 64 卦名（依八宮順序），供圖鑑收集用
export const ALL_GUA_NAMES: string[] = Object.values(GUA_NAMES);

// 依上卦分組（圖鑑直行收集用）：上卦(乾兌離震巽坎艮坤) → 該行 8 卦名
// key 首字即上卦（guaName 取 bits[3:6]=上卦在前），與 gua_ben 完全對齊
export const GUA_BY_UPPER: Record<string, string[]> = (() => {
  const g: Record<string, string[]> = {};
  for (const [key, name] of Object.entries(GUA_NAMES)) (g[key[0]] ||= []).push(name);
  return g;
})();

const PALACE_MAP: Record<string,{palace:string,shi:number,type:string}> = (() => {
  const map: Record<string,{palace:string,shi:number,type:string}> = {};
  const triBits: Record<string,number[]> = {};
  Object.entries(TRIGRAMS).forEach(([k, v]) => triBits[v] = k.split("").map(Number));
  for (const p of ["乾","兌","離","震","巽","坎","艮","坤"]) {
    let cur = [...triBits[p], ...triBits[p]];
    map[cur.join("")] = { palace: p, shi: 6, type: "本宮" };
    for (let i = 0; i < 5; i++) {
      cur = cur.slice(); cur[i] ^= 1;
      map[cur.join("")] = { palace: p, shi: i + 1, type: "一二三四五"[i] + "世" };
    }
    const yh = cur.slice(); yh[3] ^= 1;
    map[yh.join("")] = { palace: p, shi: 4, type: "遊魂" };
    const gh = yh.slice(); for (let i = 0; i < 3; i++) gh[i] ^= 1;
    map[gh.join("")] = { palace: p, shi: 3, type: "歸魂" };
  }
  return map;
})();
const pureBits = (p: string): number[] => {
  const t = Object.entries(TRIGRAMS).find(([, v]) => v === p)![0].split("").map(Number);
  return [...t, ...t];
};
type Yao = { gan: string; zhi: string; wx: string; qin: string };
function najia(bits: number[]) {
  const inner = TRIGRAMS[bits.slice(0,3).join("")], outer = TRIGRAMS[bits.slice(3,6).join("")];
  return Array.from({ length: 6 }, (_, i) => {
    const half = i < 3 ? 0 : 1, tri = half ? outer : inner;
    const zhi = NAJIA[tri].z[half][i % 3];
    return { gan: NAJIA[tri].g[half], zhi, wx: ZHI_WX[zhi] };
  });
}
const SHENG: Record<string,string> = {木:"火",火:"土",土:"金",金:"水",水:"木"};
const KE: Record<string,string> = {木:"土",土:"水",水:"火",火:"金",金:"木"};
function liuQin(pWx: string, yWx: string): string {
  if (pWx === yWx) return "兄弟";
  if (SHENG[pWx] === yWx) return "子孫";
  if (SHENG[yWx] === pWx) return "父母";
  if (KE[pWx] === yWx) return "妻財";
  return "官鬼";
}
const BEASTS = ["青龍","朱雀","勾陳","螣蛇","白虎","玄武"];
const liuShou = (dGan: number) => {
  const start = [0,0,1,1,2,3,4,4,5,5][dGan];
  return Array.from({ length: 6 }, (_, i) => BEASTS[(start + i) % 6]);
};
export const YAO_NAMES = ["初爻","二爻","三爻","四爻","五爻","上爻"];

export interface Chart {
  lines: number[]; benBits: number[]; bianBits: number[]; moving: boolean[]; hasMoving: boolean;
  benName: string; bianName: string | null;
  palace: string; palaceWx: string; shi: number; ying: number; type: string;
  ben: Yao[]; bian: Yao[] | null; beasts: string[];
  fushen: (Yao & { pos: number })[];
  ganzhi: { year: string; month: string; day: string; hour: string | null; kong: string };
  date: { y: number; m: number; d: number; hour: number | null };
  chong: boolean; he: boolean; bianChong: boolean; bianHe: boolean;
}

/** lines: 6 values (6=老陰✕ 7=少陽 8=少陰 9=老陽○), [0]=初爻 */
export function buildChart(lines: number[], y: number, m: number, d: number, hour: number | null): Chart {
  const benBits = lines.map((v) => (v === 7 || v === 9 ? 1 : 0));
  const moving = lines.map((v) => v === 6 || v === 9);
  const hasMoving = moving.some(Boolean);
  const bianBits = benBits.map((b, i) => (moving[i] ? b ^ 1 : b));
  const info = PALACE_MAP[benBits.join("")];
  const pWx = PALACE_WX[info.palace];
  const ben = najia(benBits).map((e) => ({ ...e, qin: liuQin(pWx, e.wx) }));
  const bian = hasMoving ? najia(bianBits).map((e) => ({ ...e, qin: liuQin(pWx, e.wx) })) : null;
  const dIdx = dayGZi(y, m, d);
  const present = new Set(ben.map((e) => e.qin));
  const pureNa = najia(pureBits(info.palace)).map((e) => ({ ...e, qin: liuQin(pWx, e.wx) }));
  const fushen: (Yao & { pos: number })[] = [];
  for (const q of ["父母","兄弟","官鬼","妻財","子孫"]) {
    if (!present.has(q)) pureNa.forEach((e, i) => { if (e.qin === q) fushen.push({ ...e, pos: i }); });
  }
  const bn = guaName(benBits), vn = hasMoving ? guaName(bianBits) : null;
  return {
    lines, benBits, bianBits, moving, hasMoving, ben, bian, fushen,
    benName: bn, bianName: vn,
    palace: info.palace, palaceWx: pWx, shi: info.shi, ying: ((info.shi + 2) % 6) + 1, type: info.type,
    beasts: liuShou(dIdx % 10),
    ganzhi: {
      year: gzName(yearGZi(y, m, d).idx),
      month: gzName(monthGZi(y, m, d)),
      day: gzName(dIdx),
      hour: hour == null ? null : gzName(hourGZi(dIdx % 10, hour)),
      kong: xunKong(dIdx),
    },
    date: { y, m, d, hour },
    chong: LIUCHONG.has(bn), he: LIUHE.has(bn),
    bianChong: vn ? LIUCHONG.has(vn) : false, bianHe: vn ? LIUHE.has(vn) : false,
  };
}

/** 模擬擲卦：3 枚銅錢 ×6（背=3 字=2；sum 6/7/8/9），回傳含每爻錢面 */
export function castCoins(rng: () => number = Math.random) {
  const lines: number[] = [], faces: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const coins = [0, 0, 0].map(() => (rng() < 0.5 ? 1 : 0));
    faces.push(coins);
    lines.push(coins.reduce((a, b) => a + b + 2, 0));
  }
  return { lines, faces };
}

/** 三數起卦（路一）：用戶報三數作為「靜心定卦」的儀式，
 *  確定性轉換為六爻 lines，底層仍進文王卦納甲引擎（非梅花斷法）。
 *  規則（自訂、確定性、可重現）：
 *   - 先天八卦數：乾1兌2離3震4巽5坎6艮7坤8 → 二進位三爻
 *   - 上卦 = (n1 % 8)、下卦 = (n2 % 8)（0 視為 8=坤）
 *   - 動爻 = ((n1+n2+n3) % 6)（0 視為 6）
 *   - 動爻處 7→9、8→6（陽變老陽、陰變老陰），其餘維持少陰少陽
 */
const XIANTIAN = [ // index = 卦數1..8 對應先天八卦的三爻 bits（[初,中,上]，1=陽）
  null, [1,1,1], [1,1,0], [1,0,1], [1,0,0], [0,1,1], [0,1,0], [0,0,1], [0,0,0],
] as (number[] | null)[];

export function castByNumbers(n1: number, n2: number, n3: number) {
  const up = (n1 % 8) || 8;     // 上卦數 1..8
  const down = (n2 % 8) || 8;   // 下卦數 1..8
  const moveYao = ((n1 + n2 + n3) % 6) || 6; // 動爻 1..6（初爻=1）
  const downBits = XIANTIAN[down]!; // [初,中,上]
  const upBits = XIANTIAN[up]!;
  const bits = [...downBits, ...upBits]; // lines[0]=初爻
  const lines = bits.map((b, i) => {
    if (i === moveYao - 1) return b ? 9 : 6; // 動爻：陽→老陽 陰→老陰
    return b ? 7 : 8;                          // 靜爻：陽→少陽 陰→少陰
  });
  return { lines, up, down, moveYao };
}

/** 標準盤面文字（解卦 prompt 用，同 skill 正規化格式） */
export function chartText(c: Chart, question: string): string {
  const rows: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const e = c.ben[i];
    const sy = i + 1 === c.shi ? "世" : i + 1 === c.ying ? "應" : "—";
    const mv = c.moving[i]
      ? `動（${c.lines[i] === 9 ? "老陽○" : "老陰✕"}）化出 ${c.bian![i].qin}${c.bian![i].gan}${c.bian![i].zhi}${c.bian![i].wx}`
      : "靜";
    rows.push(`${YAO_NAMES[i]} | ${c.beasts[i]} | ${e.qin} | ${e.gan}${e.zhi}(${e.wx}) | ${sy} | ${mv}`);
  }
  const fu = c.fushen.length
    ? c.fushen.map((f) => `${f.qin}${f.gan}${f.zhi}(${f.wx}) 伏於${YAO_NAMES[f.pos]}（飛神：${c.ben[f.pos].qin}${c.ben[f.pos].zhi}）`).join("；")
    : "無（六親俱全）";
  const tags = [c.chong && "本卦六沖", c.he && "本卦六合", c.bianChong && "變卦六沖", c.bianHe && "變卦六合"].filter(Boolean).join("、") || "無";
  return [
    `問事：${question || "（未填）"}`,
    `占期：${c.date.y}/${c.date.m}/${c.date.d}`,
    `干支：${c.ganzhi.year}年 ${c.ganzhi.month}月 ${c.ganzhi.day}日${c.ganzhi.hour ? " " + c.ganzhi.hour + "時" : ""}　旬空：${c.ganzhi.kong}`,
    `卦：本卦《${c.benName}》（${c.palace}宮${c.type}卦，${c.palaceWx}宮，世${c.shi}應${c.ying}）${c.hasMoving ? `之變卦《${c.bianName}》` : "，六爻安靜"}`,
    `沖合格局：${tags}`,
    `爻位 | 六獸 | 六親 | 干支(五行) | 世/應 | 動靜/變化出`,
    ...rows,
    `伏神：${fu}`,
  ].join("\n");
}
