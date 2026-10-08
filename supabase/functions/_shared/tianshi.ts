// tianshi.ts — 此刻天時：流年、月建、日辰、節氣、三元九運（六六 2026-10-05）
//
// 三位是道門中人，五術是吃飯的本事；但模型自己算干支、九運常算錯或根本不提，
// 他主動說起「丙午流年」「九紫離火運」，角色反而一臉茫然，很不專業。
// 這裡用排盤同一套曆法（core.ts，對 sxtwl 驗過）算好，當作事實給角色——
// 怎麼談、談不談，交給角色自己。

import { yearGZi, monthGZi, dayGZi, gzName, ZHI } from "./core.ts";
import { jieqiOf } from "./jieqi.ts";

const SHENGXIAO = ["鼠", "牛", "虎", "兔", "龍", "蛇", "馬", "羊", "猴", "雞", "狗", "豬"];
// 六十甲子納音，兩個甲子一組
const NAYIN = ["海中金", "爐中火", "大林木", "路旁土", "劍鋒金", "山頭火", "澗下水", "城頭土", "白蠟金", "楊柳木",
  "泉中水", "屋上土", "霹靂火", "松柏木", "長流水", "沙中金", "山下火", "平地木", "壁上土", "金箔金",
  "覆燈火", "天河水", "大驛土", "釵釧金", "桑柘木", "大溪水", "沙中土", "天上火", "石榴木", "大海水"];
const STAR = ["", "一白坎水", "二黑坤土", "三碧震木", "四綠巽木", "五黃中土", "六白乾金", "七赤兌金", "八白艮土", "九紫離火"];
const NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 三元九運：1864 起，每運二十年。以立春後的干支年（ey）算。 */
export function sanyuan(ey: number): { yun: number; yuan: string; from: number; to: number } {
  const k = Math.floor((ey - 1864) / 20);
  const yun = ((k % 9) + 9) % 9 + 1;
  return { yun, yuan: yun <= 3 ? "上元" : yun <= 6 ? "中元" : "下元", from: 1864 + k * 20, to: 1864 + k * 20 + 19 };
}
/** 流年紫白入中之星：2024 三碧、2025 二黑、2026 一白。 */
export const yearStar = (ey: number) => ((11 - (ey % 9)) % 9) || 9;

export function tianshiLine(now = Date.now()): string {
  const t = new Date(now + 8 * 3600_000);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
  const { idx: yi, ey } = yearGZi(y, m, d);
  const mi = monthGZi(y, m, d), di = dayGZi(y, m, d);
  const jq = jieqiOf(y, m, d);
  const sy = sanyuan(ey);
  const ys = yearStar(ey);
  return `【此刻天時】歲次${gzName(yi)}（${SHENGXIAO[yi % 12]}年，納音${NAYIN[Math.floor(yi / 2)]}），流年${STAR[ys]}入中；`
    + `月建${gzName(mi)}，日辰${gzName(di)}，${jq.name}第 ${jq.dayIndex} 日。`
    + `三元九運：${sy.yuan}${NUM[sy.yun]}運（${sy.from}–${sy.to}），${STAR[sy.yun]}當運。`;
}
export const __ZHI = ZHI;
