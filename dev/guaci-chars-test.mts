// dev/guaci-chars-test.mts — 模型做過頭的簡繁轉換，校回干支用字（fixGuaciChars）。
//
// 為什麼要測這一段：跟裸「＝」是同一類——不是程式產的，是模型吐的，只能在清洗層按住。
// 回報的原案是批文寫出「醜月土雖旺」，那是**丑**月。簡體的丑同時是地支的丑與醜陋的醜，
// 模型在心裡跑了一次天真的簡→繁，干支就被轉爛了。
//
// 而「按住」與「按過頭」只差一條線：無條件把醜改成丑，會把「醜陋」「家醜」一起改爛，
// 那是從一個錯字換成一整句胡話。所以下面兩邊都釘死——該改的要改，本義的一個都不許動。
//
// 跑法：node dev/guaci-chars-test.mts

const { fixGuaciChars } = await import("../supabase/functions/_shared/rules.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);
};

console.log("\n干支用字校正\n");

await t("回報的原案：醜月 → 丑月", () =>
  eq(fixGuaciChars("「但醜月土雖旺，寒氣也重，車子本身帶火性。」"),
     "「但丑月土雖旺，寒氣也重，車子本身帶火性。」", "地支的丑"));

await t("六十甲子：天干接在前面", () => {
  eq(fixGuaciChars("乙醜年生人"), "乙丑年生人", "乙丑");
  eq(fixGuaciChars("癸醜日占得此卦"), "癸丑日占得此卦", "癸丑");
});

await t("丑配時間與五行", () => {
  eq(fixGuaciChars("醜時出行不利"), "丑時出行不利", "丑時");
  eq(fixGuaciChars("用神醜土持世"), "用神丑土持世", "丑土");
  eq(fixGuaciChars("醜爻發動"), "丑爻發動", "丑爻");
});

await t("地支連寫與沖合", () => {
  eq(fixGuaciChars("子醜寅卯辰巳"), "子丑寅卯辰巳", "十二支連寫");
  eq(fixGuaciChars("醜未相沖"), "丑未相沖", "後面接地支");
  eq(fixGuaciChars("醜沖未，事有變"), "丑沖未，事有變", "後面接沖");
});

await t("同一個坑的天干：幹 → 干", () => {
  eq(fixGuaciChars("天幹地支各有所屬"), "天干地支各有所屬", "天干");
  eq(fixGuaciChars("幹支紀年"), "干支紀年", "干支");
  eq(fixGuaciChars("北鬥七星"), "北斗七星", "北斗");
});

// ── 以下每一條都不許被動到。改壞這幾句，比原本那個錯字嚴重得多。 ──

await t("醜的本義一個都不許動", () => {
  for (const s of ["這事說出去很醜", "醜陋不堪", "當眾出醜", "家醜不可外揚",
                   "他長得醜，人卻極好", "醜聞纏身", "扮醜逗你笑"])
    eq(fixGuaciChars(s), s, `不該動：${s}`);
});

await t("幹與鬥的本義一個都不許動", () => {
  for (const s of ["他很能幹", "幹活去了", "樹幹粗壯", "主幹道", "兩人鬥氣", "鬥志昂揚"])
    eq(fixGuaciChars(s), s, `不該動：${s}`);
});

await t("已經是對的，不該被二次改動", () => {
  eq(fixGuaciChars("丑月土旺"), "丑月土旺", "本來就對");
  eq(fixGuaciChars("天干地支"), "天干地支", "本來就對");
});

await t("空字串與無關句子不炸", () => {
  eq(fixGuaciChars(""), "", "空字串原樣");
  eq(fixGuaciChars("世爻持財，應期在月建"), "世爻持財，應期在月建", "沒有目標字就原樣回");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
