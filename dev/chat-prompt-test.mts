// dev/chat-prompt-test.mts — 談心提示詞精簡後（2026-09-29）的幾條底線。
//
//   ・閒聊不帶問卦三段式；像在求結果、或探詢中，才帶
//   ・記憶標得出日子（「聊過感冒就一直當他在感冒」那條）
//   ・head 不摻任何隨用戶而異的東西（快取前綴）
//
// 跑法：node --experimental-strip-types dev/chat-prompt-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { wantsAskBlock, memAge, mindLine, mergeQuotes, modernSlip, __systemPrompt: sp } = await import("../supabase/functions/_shared/chat.ts");

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) pass++; else { fail++; console.log("✗", name); } };

// 閒聊：不帶
for (const m of ["今天好累", "師兄你在幹嘛", "我剛吃完飯", "你喜歡喝什麼茶", "哈哈你好可愛"])
  ok(`閒聊不帶：${m}`, !wantsAskBlock(m));
// 求結果：帶
for (const m of ["這個案子會不會成", "我該不該換工作", "他什麼時候會回來", "幫我看一下財運", "童童要不要看醫生", "想問一卦"])
  ok(`求結果要帶：${m}`, wantsAskBlock(m));
ok("探詢中一律帶", wantsAskBlock("嗯對啊", 1));

const now = Date.parse("2026-09-29T10:00:00+08:00");
ok("今天", memAge("2026-09-29T01:00:00+08:00", now) === "〔9/29・今天〕");
ok("昨天", memAge("2026-09-28T23:00:00+08:00", now) === "〔9/28・昨天〕");
ok("三天前", memAge("2026-09-26T12:00:00+08:00", now) === "〔9/26・3 天前〕");
ok("沒日期不標", memAge(undefined, now) === "");

const persona = "【人設】我是大師兄。";
const a = sp(persona, "", "六六", "・〔9/20・1 週前〕他那陣子感冒了", "", "daoshi_m", 100, 0, "", "", "", "", false);
const b = sp(persona, "・問X→《乾》", "別人", "", "", "daoshi_m", 900, 0, "", "", "", "", true);
ok("head 對不同用戶逐字相同", a.head === b.head);
ok("head 以人設開頭", a.head.startsWith(persona));
ok("閒聊 tail 不含擬題規矩", !a.tail.includes("[[DRAFT"));
ok("求結果 tail 含擬題規矩", b.tail.includes("[[DRAFT|理好的問句|用神六親|事由|一句話說這件事]]"));
ok("記憶附上時態提醒", a.tail.includes("都是那天的事"));
// 思路與可破的邊界（MIND）：依層給，進 tail 不進 head
ok("你這個人在 tail、不在 head", a.tail.includes("【你這個人】") && !a.head.includes("【你這個人】"));
ok("大師兄未到第四層：不接情緒", !mindLine("daoshi_m", 649).includes("笨拙"));
ok("大師兄第四層（650）：笨拙共情", mindLine("daoshi_m", 650).includes("笨拙"));
ok("師妹初識就共情", mindLine("daoshi_f", 0).includes("懂人的感受"));
ok("觀喵第一層：懶得搭理", mindLine("lingshou", 299).includes("不熟"));
ok("觀喵第二層（300）：安慰、無大道理", mindLine("lingshou", 300).includes("安慰") && !mindLine("lingshou", 300).includes("道理"));
ok("觀喵第三層（500）：講大道理", mindLine("lingshou", 500).includes("道理"));
ok("第六層才有生氣規則", b.tail.includes("[[SULK]]") === false && sp(persona, "", "", "", "", "lingshou", 960, 0, "", "", "", "", false).tail.includes("[[SULK]]"));
// 台詞併段（mergeQuotes）
ok("逗號半句隔旁白 → 接起來、旁白提前",
  mergeQuotes("「武曲星坐命，」\n＊她慢慢說＊\n「所以非得研究。」") === "＊她慢慢說＊\n「武曲星坐命，所以非得研究。」");
ok("相鄰台詞併成一個", mergeQuotes("「活著就好。」\n「別想太多」") === "「活著就好。別想太多」");
ok("台詞之間的空行吃掉", mergeQuotes("「a。」\n\n「b。」") === "「a。b。」");
ok("旁白與台詞之間的空行留著", mergeQuotes("＊他放下筆＊\n\n「睡覺。」") === "＊他放下筆＊\n\n「睡覺。」");
ok("句號收尾的台詞不跨旁白接", mergeQuotes("「好。」\n＊他看你＊\n「睡。」") === "「好。」\n＊他看你＊\n「睡。」");
// 他先說的今時器物，角色跟著提不算出戲
ok("他說冰箱，角色問冰箱是什麼不算出戲", !modernSlip("「冰箱是什麼？」", "我把湯放冰箱"));
ok("角色自己冒出冰箱算出戲", modernSlip("「放冰箱。」", "湯要怎麼放"));
console.log(`head ${a.head.length - persona.length} 字（不含人設）；閒聊 tail ${a.tail.length} 字；問卦 tail ${b.tail.length} 字`);

console.log(`\n${pass} 過 / ${fail} 敗`);
if (fail) process.exit(1);
