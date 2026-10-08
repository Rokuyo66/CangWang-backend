// dev/romance-test.mts — 好感分層（六層統一門檻）、跳級偵測、第六層倒扣。
// 跑法：node dev/romance-test.mts
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { romanceLevel, favorTierName, overLevel, favorAfter, parseMarks, chatFavorCap, FREE_CHAT_FAVOR_CAP } = await import("../supabase/functions/_shared/chat.ts");
let p = 0, f = 0; const t = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };
// 三人同一組門檻：300／500／650／800／950
for (const c of ["daoshi_m", "daoshi_f", "lingshou"]) {
  t(`${c} 299 → 0`, romanceLevel(c, 299) === 0);
  t(`${c} 300 → 1`, romanceLevel(c, 300) === 1);
  t(`${c} 650 → 3`, romanceLevel(c, 650) === 3);
  t(`${c} 960 → 5`, romanceLevel(c, 960) === 5);
}
t("569 相知", favorTierName(569) === "相知");
t("700 相惜", favorTierName(700) === "相惜");
t("900 知己", favorTierName(900) === "知己");
t("950 同心", favorTierName(950) === "同心");
t("相知不可擁抱", overLevel("daoshi_m", 600, "＊他抱住你＊"));
t("相惜可以擁抱", !overLevel("daoshi_m", 700, "＊他抱住你＊"));
t("相惜不可親吻", overLevel("daoshi_m", 700, "＊他在你額上輕吻＊"));
t("知己可以親吻", !overLevel("daoshi_m", 850, "＊他在你額上輕吻＊"));
t("初識說喜歡跳級", overLevel("daoshi_f", 100, "我喜歡你"));
// 倒扣：只有第六層、只有吐了 [[SULK]]；掉回第五層就不再扣
t("第六層生氣反扣", favorAfter(960, true) === 955);
t("掉回第五層不再扣", favorAfter(948, true) === 949);
// 無牒閒聊好感封頂在第一層門檻前（299）；持牒不封
t("無牒頂＝第一層前一格", FREE_CHAT_FAVOR_CAP === 299 && chatFavorCap("free") === 299);
t("持牒不封", chatFavorCap("guanwei") > 900);
t("無牒聊到 299 停", favorAfter(299, false, chatFavorCap("free")) === 299);
t("無牒未到頂照長", favorAfter(120, false, chatFavorCap("free")) === 121);
t("靠問卦過頂的不被扣回", favorAfter(320, false, chatFavorCap("free")) === 320);
t("持牒照長", favorAfter(299, false, chatFavorCap("zhiji")) === 300);
t("沒生氣照常 +1", favorAfter(960, false) === 961);
t("上限封頂", favorAfter(999, false) === 999);
const m = parseMarks("「你又來了。」\n[[SULK]]");
t("SULK 標記被剝掉", m.sulk && m.clean === "「你又來了。」");
t("沒標記不算生氣", !parseMarks("「好。」").sulk);
console.log(`\n${p} 過 / ${f} 敗`); if (f) process.exit(1);
