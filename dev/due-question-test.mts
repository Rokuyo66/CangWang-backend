// dev/due-question-test.mts — 問句自帶日期 → 應期（rules.ts dueFromQuestion）。
// 模型沒給 due 時的零 AI 保底：只認一個明確的日子，分數、兩個日子、「之後」都不算。
// 跑法：node --experimental-strip-types dev/due-question-test.mts
const { dueFromQuestion, questionDateNote } = await import("../supabase/functions/_shared/rules.ts");
const C="2026-10-03";
const cases: [string,string|null][] = [
 ["10/11跟安妮去空總基地怎麼樣？","2026-10-11"],
 ["10／11 會下雨嗎","2026-10-11"],
 ["10月11日面試結果","2026-10-11"],
 ["10月11號見面順利嗎","2026-10-11"],
 ["2026/10/20 搬家好嗎","2026-10-20"],
 ["明天會放假嗎","2026-10-04"],
 ["後天考試","2026-10-05"],
 ["大後天出發順利嗎","2026-10-06"],
 ["今天會下雨嗎","2026-10-03"],
 ["1/5 開工順利嗎","2027-01-05"],
 ["9/30 那件事是誰做的","" ],
 ["10/11 還是 10/18 去比較好",null],
 ["10/11之後會好轉嗎",null],
 ["10/11之前拿得到錢嗎","2026-10-11"],
 ["換工作好嗎",null],
 ["成功率 1/2 嗎",null],
 ["2/30 會怎樣",null],
];
let f=0; for(const [q,e] of cases){ const r=dueFromQuestion(q,C); const exp=e===""?null:e; const ok=r===exp; if(!ok)f++; console.log(ok?"✅":"❌",q,"→",r);}

// questionDateNote：距幾天由程式算好交給模型（2026-11-04 回報：12/20 被說成「一年多」，實際 46 天）
const notes: [string, string, string|undefined, string][] = [
 ["12/20的家庭日活動我有機會抽到大獎金嗎", "2026-11-04", undefined, "2026/12/20，距占期 46 天（約 7 週）"],
 ["明天面試順利嗎", "2026-11-04", undefined, "2026/11/05，距占期 1 天。"],
 ["12/20的家庭日活動我有機會抽到大獎金嗎", "2026-11-04", "2026-12-25", "2026/12/20，已過 5 天"],
 ["1/5 開會順利嗎", "2026-12-20", "2026-12-30", "2027/01/05，距今日 6 天。"],
 ["這份工作適合我嗎", "2026-11-04", undefined, ""],
];
for (const [q, c, t, want] of notes) {
  const r = questionDateNote(q, c, t);
  const ok = want === "" ? r === "" : r.includes(want);
  if (!ok) f++;
  console.log(ok ? "✅" : "❌", "note:", q, t ?? "", "→", r.trim() || "(空)");
}
console.log(f?`${f} 敗`:"全過"); if(f) process.exit(1);
