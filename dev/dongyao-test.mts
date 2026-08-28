// dev/dongyao-test.mts — 動爻判定與作用鏈驗證。
//
// 基準案例即 2026-08-28 出問題的那一卦：丙申月甲戌日《震為雷》之《坤為地》。
// 該卦上爻妻財戌土臨日建（忌神），舊版判為靜爻不作用，於是「忌神剋用神父母子水」
// 整條被漏掉。本測試把五條裁決逐條釘死，回歸時立刻炸。
//
// 跑法：node dev/dongyao-test.mts

import { buildChart, dayGZi, gzName } from "../supabase/functions/_shared/core.ts";
import {
  actorsOf, edgesOf, dongyaoText, bianActs, isActive, isRiChen, isAnDong,
  isChongTuo, effWang, selfCheck,
} from "../supabase/functions/_shared/dongyao.ts";

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) { fail++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`);
};

/* ═══ 找出丙申月甲戌日（2026 年 = 丙午年） ═══ */
function findDay(want: string, y: number, from: number, to: number) {
  for (let m = 8; m <= 9; m++)
    for (let d = 1; d <= 31; d++)
      if (gzName(dayGZi(y, m, d)) === want && (m > 8 || d >= from) && (m < 9 || d <= to))
        return { y, m, d };
  throw new Error(`找不到 ${want}`);
}
const day = findDay("甲戌", 2026, 1, 6);

/* ═══ 基準卦：《震為雷》之《坤為地》，初爻與四爻動 ═══ */
// 震＝100（初陽二陰三陰），上下皆震；初爻、四爻為老陽○
const lines = [9, 8, 8, 9, 8, 8];
const c = buildChart(lines, day.y, day.m, day.d, 13); // 未時

console.log(`\n盤面：${c.ganzhi.year}年 ${c.ganzhi.month}月 ${c.ganzhi.day}日　旬空${c.ganzhi.kong}`);
console.log(`《${c.benName}》之《${c.bianName}》　世${c.shi}應${c.ying}\n`);

console.log("── 一、盤面前提 ──");
ok(c.benName === "震為雷", `本卦為震為雷（得 ${c.benName}）`);
ok(c.bianName === "坤為地", `變卦為坤為地（得 ${c.bianName}）`);
ok(c.ganzhi.day === "甲戌", `日辰甲戌（得 ${c.ganzhi.day}）`);
ok(c.ganzhi.month === "丙申", `月建丙申（得 ${c.ganzhi.month}）`);
ok(c.ben[5].zhi === "戌" && c.ben[5].qin === "妻財", "上爻為妻財戌土");
ok(c.ben[0].zhi === "子" && c.ben[0].qin === "父母", "初爻為父母子水（用神）");

console.log("\n── 二、裁決①：日辰入卦視為動爻，直接以旺論 ──");
ok(isRiChen("戌", c), "上爻戌土＝日辰入卦");
ok(isActive(c, 5), "上爻雖非老陰老陽，仍判為能作用之爻");
ok(effWang("戌", "土", c) === "旺", `上爻戌土實效旺衰以旺論（月令申為休，得 ${effWang("戌", "土", c)}）`);
ok(effWang("辰", "土", c) === "休", `三爻辰土同為土，不因戌臨日建而得旺（得 ${effWang("辰", "土", c)}）`);
ok(!isActive(c, 2), "三爻辰土不作用（日沖而月令休＝日破）");

console.log("\n── 三、裁決②：變爻回頭生剋則作用盡於本位，否則參戰 ──");
ok(!bianActs(c, 0).active, `初爻變爻未土已回頭剋本位，不再與他爻論生剋（${bianActs(c, 0).why}）`);
ok(bianActs(c, 3).active, `四爻變爻丑土未回頭生剋本位，視同動爻參戰（${bianActs(c, 3).why}）`);

console.log("\n── 四、裁決④：日沖之爻也動（暗動／沖脫／日破三分） ──");
ok(!isChongTuo("午", c, true), "四爻午火非沖脫（午不沖戌）");
ok(!isAnDong("辰", "土", c, false), "三爻辰土逢日沖但月令休 → 非暗動，是日破");

/** 掃出第一個滿足條件的卦盤，用來驗基準卦沒踩到的分支 */
function hunt(want: (ch: ReturnType<typeof buildChart>) => boolean) {
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= 28; d++)
    for (let bits = 0; bits < 64; bits++) for (let mask = 0; mask < 64; mask++) {
      const ls = Array.from({ length: 6 }, (_, i) => {
        const yang = (bits >> i) & 1, mv = (mask >> i) & 1;
        return mv ? (yang ? 9 : 6) : (yang ? 7 : 8);
      });
      const ch = buildChart(ls, 2026, m, d, 13);
      if (want(ch)) return ch;
    }
  throw new Error("掃不到符合條件的卦");
}

const cAn = hunt((ch) => actorsOf(ch).some((a) => a.kind === "暗動"));
{
  const a = actorsOf(cAn).find((x) => x.kind === "暗動")!;
  ok(!cAn.moving[a.pos], `暗動者必為靜爻（${cAn.ganzhi.day}日 ${a.zhi}${a.wx}）`);
  ok(!a.chongHe, "暗動之爻有生剋而無沖合之力");
  ok(!edgesOf(cAn).some((e) => e.actor === a && (e.rel === "沖" || e.rel === "合")),
     "作用鏈中暗動者不出現沖合，只出現生剋");
}

const cTuo = hunt((ch) => actorsOf(ch).some((a) => a.notes.some((n) => n.startsWith("沖脫"))));
{
  const a = actorsOf(cTuo).find((x) => x.notes.some((n) => n.startsWith("沖脫")))!;
  ok(a.kind === "發動", "沖脫者仍列為發動、仍作用（進行而後散）");
  ok(!bianActs(cTuo, a.pos).active, "沖脫之本位動爻，其變爻不論");
}

console.log("\n── 五、裁決③：作用鏈——忌神剋用神必須被抓出來 ──");
const edges = edgesOf(c);
const hitYong = edges.filter((e) => e.target === 0 && e.rel === "剋");
ok(hitYong.some((e) => e.actor.pos === 5 && e.actor.from === "本爻"),
   "上爻妻財戌土（日辰入卦·忌神）剋初爻用神父母子水 —— 舊版整條漏判");
ok(hitYong.some((e) => e.actor.pos === 3 && e.actor.from === "變爻"),
   "四爻變爻妻財丑土（參戰）亦剋初爻用神");
ok(!actorsOf(c).some((a) => a.from === "日辰"),
   "日辰已入卦（上爻戌土），本體不另列一行，免得同一股力被算兩次");
const rescue = edges.filter((e) => e.target === 0 && (e.rel === "生" || e.rel === "合"));
console.log(`  · 初爻用神之救應：${rescue.map((e) => `${e.actor.kind}${e.actor.zhi}之${e.rel}`).join("、") || "無"}`);

console.log("\n── 六、裁決⑤：沖中逢合／合後逢沖 ──");
const txt = dongyaoText(c);
ok(txt.includes("合後逢沖"), "三爻辰土得四爻午火之生、又被日辰戌所沖 → 合後逢沖（先順後敗）");
const cHe = hunt((ch) => dongyaoText(ch).includes("沖中逢合"));
ok(dongyaoText(cHe).includes("沖中逢合"),
   `沖中逢合可判出（${cHe.ganzhi.day}日《${cHe.benName}》）——先受動爻沖剋、後得日辰來合`);

console.log("\n── 七、自檢 ──");
const errs = selfCheck();
ok(errs.length === 0, `卦理常數自檢（${errs.length ? errs.join("；") : "全過"}）`);

console.log("\n══════ 產出之【動爻】區塊 ══════\n");
console.log(txt);

console.log(`\n${fail ? `✗ ${fail} 項不過` : "✓ 全過"}`);
process.exit(fail ? 1 : 0);
