// dev/narration-test.mts — 旁白第一人稱正規化（normalizeNarration）。
//
// 這一支的工作是「把旁白裡的我改成他，台詞裡的我留著」。兩邊都會出事：
// 改不夠 → 大師兄的動作寫成第一人稱，視角穿幫；改過頭 → 他講自己的話變成第三人稱，
// 而後者更可怕，因為讀起來像角色壞了，不像格式壞了。
//
// 回報的原案：大師兄講「……他知道。」——他要說的是「我知道」。
// 原因是模型漏寫一個收尾的＊，那顆孤兒＊跟下一行的＊配成一對，把中間的台詞吞進旁白。
// 舊註解寫「未成對的＊不會被匹配，原樣保留」，那句是錯的，而且整段邏輯壓在那句上。
//
// 跑法：node dev/narration-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { __normalizeNarration: norm } = await import("../supabase/functions/_shared/chat.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}\n     得到 ${JSON.stringify(a)}\n     預期 ${JSON.stringify(b)}`);
};

console.log("\n旁白第一人稱正規化\n");

await t("旁白裡的我要改", () =>
  eq(norm("＊我看著你，停頓了一下＊", "daoshi_m"), "＊他看著你，停頓了一下＊", "旁白轉第三人稱"));

await t("台詞裡的我不許改", () =>
  eq(norm("「……我知道。」", "daoshi_m"), "「……我知道。」", "台詞保留第一人稱"));

await t("回報的原案：孤兒＊吞掉下一行的台詞", () =>
  eq(norm("＊停頓，他的聲音變得很低\n「……我知道。」\n＊他往前靠了半步＊", "daoshi_m"),
     "＊停頓，他的聲音變得很低\n「……我知道。」\n＊他往前靠了半步＊",
     "漏寫收尾＊時，下一行的台詞不該被吞進旁白"));

await t("同一行內的孤兒＊也吞不到台詞（第二道防線）", () =>
  eq(norm("＊他停了一下 「我知道。」 ＊他又說＊", "daoshi_m"),
     "＊他停了一下 「我知道。」 ＊他又說＊", "引號內一律不動"));

await t("結尾多一個孤零零的＊不炸也不誤改", () =>
  eq(norm("＊不是問句，是確認＊\n「……我知道。」\n＊", "daoshi_m"),
     "＊不是問句，是確認＊\n「……我知道。」\n＊", "孤兒＊原樣留著"));

await t("旁白與台詞交錯，各歸各位", () =>
  eq(norm("＊我看著你＊\n「我知道。」\n＊我沒有往回靠＊", "daoshi_m"),
     "＊他看著你＊\n「我知道。」\n＊他沒有往回靠＊", "旁白改、台詞不改"));

await t("舊格式的（…）一樣算旁白", () =>
  eq(norm("（我把卦紙推過去）", "lingshou"), "（牠把卦紙推過去）", "全形括號也是旁白"));

await t("三個角色各用各的代稱", () => {
  eq(norm("＊我笑了＊", "daoshi_m"), "＊他笑了＊", "大師兄→他");
  eq(norm("＊我笑了＊", "daoshi_f"), "＊她笑了＊", "師妹→她");
  eq(norm("＊我笑了＊", "lingshou"), "＊牠笑了＊", "觀喵→牠");
});

await t("我的／我們一併涵蓋", () =>
  eq(norm("＊我的手停在我們之間＊", "daoshi_m"), "＊他的手停在他們之間＊", "不必另寫規則"));

await t("沒帶引號的裸台詞仍保留我（原本的設計意圖）", () =>
  eq(norm("我知道。\n＊他往前靠＊", "daoshi_m"), "我知道。\n＊他往前靠＊", "＊外面一律當台詞"));

await t("空字串與純台詞不炸", () => {
  eq(norm("", "daoshi_m"), "", "空字串原樣");
  eq(norm("你先回家躺著。明天再說。", "daoshi_m"), "你先回家躺著。明天再說。", "沒有標記就不動");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
