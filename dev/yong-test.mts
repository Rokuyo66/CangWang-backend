// dev/yong-test.mts — 用神取應爻（【交涉】取法）與用神爻位鎖定。
//
// 起因是線上一張真卦：丙午年丁酉月戊戌日，問「CC 是適合我合作的室內設計師嗎」，
// 起出《火地晉》之《火風鼎》。問的是「這個外部設計師本人可不可靠」，正統取法是
// 以應爻為用（無稱謂可歸的外部對象），但當時 <yong> 標籤只收六親與「世爻」——
// 應爻填不出來，解卦人只好退而求其次填了妻財。
//
// 後果不是標籤標錯而已，是主詞換了人：妻財卯木月破，於是被讀成「這個設計師
// 能量狀態偏弱、會拖、會耗」。月破的是錢，不是人；那張卦的應爻父母未土得日辰
// 戊戌比和拱扶，不空不破不動，而且應生世（未土生酉金世爻）——對方其實是配合的。
//
// 這幾條測試釘住三件事：①應爻填得出來 ②「應爻（父母）」不會被誤讀成一般的父母為用
// ③用神取應／取世一律是爻位直取，不繞六親查找（繞回去就會鎖到兩現的另一爻）。
//
// 跑法：node dev/yong-test.mts

import { buildChart, pickUsePos, type Chart } from "../supabase/functions/_shared/core.ts";
import { parseTagged } from "../supabase/functions/_shared/rules.ts";

// qrefine.ts 順著 services.ts 在載入時就讀 Deno.env（模型名、金鑰），node 沒有這個全域。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { normYong } = await import("../supabase/functions/_shared/qrefine.ts");

let pass = 0, fail = 0;
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const tagged = (yong: string) => parseTagged(`正文。\n<sugg>a|b|c</sugg>\n<due>null</due>\n<cat>事業</cat>\n<digest>x</digest>\n<yong>${yong}</yong>`);

/* ═══════════════ 一、<yong> 標籤解析 ═══════════════ */
console.log("\n【<yong> 標籤解析】");

t("應爻填得出來", () => {
  const y = tagged("應爻")!.yong!;
  eq(y.viaYing, true, "viaYing 該為 true");
  eq(y.viaShi, false, "viaShi 該為 false");
  eq(y.qin, null, "六親留給排盤端由應爻決定");
});

t("「應爻（父母）」不被誤讀成一般的父母為用", () => {
  const y = tagged("應爻（父母）")!.yong!;
  eq(y.viaYing, true, "括號裡的六親不該蓋過應爻");
  eq(y.qin, null, "qin 不該被填成父母");
});

t("世爻仍走原路徑", () => {
  const y = tagged("世爻")!.yong!;
  eq(y.viaShi, true, "viaShi 該為 true");
  eq(y.viaYing, false, "viaYing 該為 false");
});

t("六親照舊", () => {
  const y = tagged("妻財")!.yong!;
  eq(y.qin, "妻財", "六親該照收");
  eq(y.viaShi, false, "不該誤判為世爻");
  eq(y.viaYing, false, "不該誤判為應爻");
});

t("雜訊仍視為未取定", () => eq(tagged("看情況再說")!.yong, null, "認不得就該回 null"));

// 「全盤」＝此問無單一成敗所繫（格局題、狀態題、多線無主從），解卦人可以誠實不抓一爻。
// 它與「沒認出來」刻意落到同一個 null：下游的要求本來就一樣——不釘用神提示、
// 追問與展開照精簡版走、溫度線退回世爻。多一個欄位分辨兩者換不到不同的行為。
t("全盤＝不取單一用神，落到 null", () => {
  eq(tagged("全盤")!.yong, null, "全盤該回 null");
  eq(tagged("全盤（此問無單一成敗所繫）")!.yong, null, "帶說明的全盤同樣認得");
});

t("全盤不被六親字樣拖回單一用神", () => {
  // 模型可能寫「全盤論，妻財官鬼各自分論」——先掃六親會把它釘成妻財為用
  eq(tagged("全盤：妻財與官鬼各論其事")!.yong, null, "全盤該先於六親比對");
});

t("擬題層的 normYong 同樣認得應爻", () => {
  eq(normYong("應爻")?.viaYing, true, "應爻");
  eq(normYong("世爻")?.viaShi, true, "世爻");
  eq(normYong("官鬼")?.qin, "官鬼", "六親");
  eq(normYong("null"), null, "null");
});

/* ═══════════════ 二、爻位鎖定 ═══════════════ */
console.log("\n【爻位鎖定】");

// 《火地晉》：坤下離上。lines 初→上，6＝老陰動、7＝少陽、8＝少陰。
// 二爻與三爻動 → 之《火風鼎》。占期 2026-09-21 申時＝丙午年丁酉月戊戌日庚申時。
const JIN = buildChart([8, 6, 6, 7, 8, 7], 2026, 9, 21, 16);

t("盤面與線上那一卦相符", () => {
  eq(JIN.benName, "火地晉", "本卦");
  eq(JIN.bianName, "火風鼎", "變卦");
  eq(JIN.shi, 4, "世在四爻");
  eq(JIN.ying, 1, "應在初爻");
  eq(JIN.ben[0].qin, "父母", "初爻六親");
  eq(JIN.ben[0].zhi, "未", "初爻地支");
  eq(JIN.ben[3].qin, "兄弟", "四爻（世）六親");
  eq(JIN.ben[2].qin, "妻財", "三爻六親");
});

t("用神取應 → 鎖初爻（那一爻才是 CC）", () => {
  eq(pickUsePos(JIN, JIN.ben[JIN.ying - 1].qin, false, true), 0, "應爻在初爻");
});

t("用神取世 → 鎖四爻", () => {
  eq(pickUsePos(JIN, JIN.ben[JIN.shi - 1].qin, true, false), 3, "世爻在四爻");
});

t("六親路徑不受影響", () => {
  eq(pickUsePos(JIN, "妻財"), 2, "妻財只一現，落三爻");
});

// 用神兩現時，爻位直取與六親查找會鎖到不同爻——這正是 viaShi／viaYing 必須
// 繞開六親比對的理由。父母在此卦兩現（初爻與五爻），六親查找取到的是先出現的那個，
// 應爻要的卻是初爻；換一張應在上爻的卦，兩者就會分岔。
t("兩現時 viaYing 不繞六親、直取應爻", () => {
  const fake = { ...JIN, shi: 2, ying: 5 } as Chart;   // 假設應在五爻（父母未土亦在五爻）
  eq(pickUsePos(fake, "父母", false, true), 4, "viaYing 該直取五爻");
  eq(pickUsePos(fake, "父母"), 4, "此例六親查找也避世、優先應，結果相同");
  const fake2 = { ...JIN, shi: 1, ying: 5 } as Chart;
  eq(pickUsePos(fake2, "父母", false, true), 4, "應在五爻即鎖五爻，不因六親兩現而動搖");
});

console.log(`\n${pass} 過、${fail} 敗`);
if (fail) process.exit(1);
console.log("✓ 全過");
