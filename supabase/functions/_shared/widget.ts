// _shared/widget.ts — 桌面小工具（Web / App widget）的文案與配色表
//
// 這一支是純的：不碰資料庫、不讀 Deno.env、不 import 任何一者。
// 因為它同時要被兩邊吃——伺服器組小工具狀態（widget-state.ts），
// 以及前端原型直接 bundle 進瀏覽器（dev/widget/entry.ts）。
// 只要這裡混進一行 supabase 或 Deno，原型那一側當場在瀏覽器裡炸開，
// 而修法多半會是「複製一份文案到前端」——那就等於行止有兩個版本。
//
// 小工具與 App 首頁是兩種東西：首頁是「進來辦事」，小工具是「路過瞄一眼」。
// 一眼要看見的只有四件事——今天是什麼日子、簽到了沒、今日行止、以及一顆問卦鈕。

import type { QianTier } from "./qian60.ts";

/* ---------- 行止：等第 → 桌面上那一個詞 ---------- */

/** 四級行止。取名照「進退」而非「吉凶」——小工具是每天要看的東西，
 *  天天被斷吉凶會膩，被指出今天該進還是該守才用得上。 */
export type Stance = "xing" | "ke" | "chang" | "shou";

export interface StanceInfo {
  key: Stance;
  label: string;    // 兩字大字：且行／可行／守常／宜守
  line: string;     // 一句話建議（小工具唯一的完整句子）
  yi: string[];     // 宜（農民曆體例，二字一條）
  ji: string[];     // 忌
}

/** 等第 → 行止。四級對四級，不插值：
 *  fortuneTier 的最差一級講的就是「宜守」而非凶（見 fortune.ts 的門檻註解），
 *  這裡照著收——桌面上每天都會出現的東西，不該有一天是勸退的。 */
export const STANCE: Record<QianTier, StanceInfo> = {
  daji: { key: "xing", label: "且行", line: "勢在你這邊：該開口的開口、該決的決，別再等一個更好的日子。",
    yi: ["出行", "開口", "決事"], ji: ["猶疑", "空等"] },
  ji: { key: "ke", label: "可行", line: "順風但不算大風：先做手邊那件小的，做成了再談大的。",
    yi: ["小成", "修補", "問人"], ji: ["貪大", "躁進"] },
  ping: { key: "chang", label: "守常", line: "不進不退之日，照舊章辦事最省力；別在今天改規矩。",
    yi: ["照舊", "整理", "對帳"], ji: ["更張", "新約"] },
  shou: { key: "shou", label: "宜守", line: "力道不在，硬推只會多一道傷；今天守得住，明天才有得爭。",
    yi: ["守成", "養息", "觀望"], ji: ["動土", "爭執", "借貸"] },
};

export const stanceOf = (tier: QianTier): StanceInfo => STANCE[tier];

/* ---------- 配色 ---------- */

/** 小工具可用的配色。內建兩套（宣紙、夜觀）不入 profiles.owned_themes，見 0033。
 *  付費三套的價目以呼叫端傳進來的 THEME_PRICES 為準——價目只有一份，在 interpret/index.ts。
 *  規則：App 裡沒解鎖的，小工具也不給用；解了竹簡，小工具才選得到竹簡。
 *  但兩邊可以各選各的——桌面想用夜觀、App 裡用竹簡，是合理的，不強制同步。 */
export const THEME_NAMES: Record<string, string> = {
  xuan: "宣紙", night: "夜觀", bamboo: "竹簡", cinnabar: "硃砂", porcelain: "青瓷",
};
export const BUILTIN_THEMES = ["xuan", "night"];

export interface WidgetTheme {
  key: string;
  name: string;
  locked: boolean;
  price: number | null;   // 內建為 null；付費且已解鎖也回價目（前端要標「已擁有」用得上）
}

export function themeList(owned: string[], prices: Record<string, number>): WidgetTheme[] {
  // 已買但已從價目表下架的配色也要列。配色是買斷制，下架是「不再賣」，
  // 不是「從買過的人桌面上收走」——只看 prices 的話，下架那天它就從小工具裡消失了。
  const retired = owned.filter((k) => !BUILTIN_THEMES.includes(k) && !(k in prices));
  return [...BUILTIN_THEMES, ...Object.keys(prices), ...retired].map((key) => ({
    key,
    name: THEME_NAMES[key] ?? key,
    locked: !BUILTIN_THEMES.includes(key) && !owned.includes(key),
    price: prices[key] ?? null,
  }));
}

