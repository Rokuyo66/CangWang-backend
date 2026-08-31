// dev/chat-scrub-test.mts — 旁白裡的裸「＝」剝除（scrubStrayEq）。
//
// 為什麼要測這一段：這顆符號不是程式產的，是模型吐的，所以只能在清洗層按住。
// 而「按住」與「按過頭」只差一條線——真的等式（x=1）、使用者自己打的算式若被吃掉，
// 就從一個小髒點換成一個資料損毀。這裡把兩邊都釘死。
//
// 跑法：node dev/chat-scrub-test.mts

// chat.ts 載入時會讀 Deno.env（模型名、額度預設值），node 沒有這個全域，
// 先擺一個只會回 undefined 的替身，讓它全部走預設值（同 guide-test.mts）。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

const { scrubStrayEq } = await import("../supabase/functions/_shared/chat.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);
};

console.log("\n旁白裡的裸「＝」\n");

await t("旁白收尾滑出來的全形＝（回報的原案）", () =>
  eq(scrubStrayEq("＊大師兄看著你，停頓了一下＝＊"), "＊大師兄看著你，停頓了一下＊", "尾巴要剝掉，旁白其餘不動"));

await t("半形 = 一樣剝", () =>
  eq(scrubStrayEq("＊他的手從卦紙上鬆開，往後靠=＊"), "＊他的手從卦紙上鬆開，往後靠＊", "半形也算裸露"));

await t("連著好幾顆（==、＝＝）一次剝乾淨", () =>
  eq(scrubStrayEq("＊他偏頭==＊\n\n「那就不是工作的事。」"), "＊他偏頭＊\n\n「那就不是工作的事。」", "整串剝掉"));

await t("台詞裡的也剝——它出現在哪裡都不是中文", () =>
  eq(scrubStrayEq("「隨你＝。」"), "「隨你。」", "「」內同樣處理"));

await t("剝完不留空白、不動其他標點", () =>
  eq(scrubStrayEq("＊師妹替你添了些茶＝＊「先坐。」"), "＊師妹替你添了些茶＊「先坐。」", "只拿走那一顆"));

await t("真的等式不動：英數＝英數", () =>
  eq(scrubStrayEq("x=1"), "x=1", "兩邊都是英數就是等式，不可吃掉"));

await t("全形等式也不動", () =>
  eq(scrubStrayEq("A＝B"), "A＝B", "全形寫法同理"));

await t("連等式不動", () =>
  eq(scrubStrayEq("a=b=c"), "a=b=c", "中間每一顆兩邊都是英數"));

await t("半吊子等式（只有一邊是英數）視為裸露", () =>
  eq(scrubStrayEq("好了=，就這樣"), "好了，就這樣", "右邊不是英數，剝"));

await t("沒有＝的句子原樣回，空字串也不炸", () => {
  eq(scrubStrayEq("＊大師兄闔上卦書＊"), "＊大師兄闔上卦書＊", "不該動的別動");
  eq(scrubStrayEq(""), "", "空字串原樣");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
