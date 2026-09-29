// dev/chat-era-test.mts — 古風出戲偵測（MODERN_RE）。
//
// 為什麼要測：這支正則決定「要不要多花一次模型重生」。抓漏了，角色會說出開車、冰箱；
// 抓過頭（把古今通用的字當成今時），每句話都會被重生一次，錢與延遲都白花。兩邊都釘死。
//
// 跑法：node dev/chat-era-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { MODERN_RE } = await import("../supabase/functions/_shared/chat.ts");

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${name}`); };

console.log("今時的器物：要抓到");
for (const s of [
  "「感冒的人，不要自己開車。我陪你去。」",
  "＊師妹把剩下的點心收進冰箱＊",
  "＊大師兄靠在沙發上翻卦書＊",
  "「你又在滑手機了？」",
  "「先去醫院掛號，別拖。」",
  "「喝杯咖啡提提神吧。」",
]) t(s, MODERN_RE.test(s));

console.log("古今通用、觀中本來就有的：不能誤判");
for (const s of [
  "「別獨自上路，找個人送你去醫館。」",
  "＊他把茶盞推到你面前＊「先喝口熱的。」",
  "「有什麼訊息，捎個信來便是。」",
  "＊觀喵跳上竹椅，尾巴掃過燈芯＊",
  "「驢車明早才到山下。」",
  "「大夫說要靜養三日。」",
]) t(s, !MODERN_RE.test(s));

console.log(`\n${pass} 過、${fail} 失敗`);
if (fail) process.exit(1);
