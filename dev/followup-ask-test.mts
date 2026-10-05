// dev/followup-ask-test.mts — 追問的反問與修正（0078），整條 followupInterpret 走一遍，模型以假 fetch 頂替。
// 跑法：deno run -A dev/followup-ask-test.mts
//
// 驗：反問接在答覆末尾、一字不差存進 ask；回答反問那一次不收費也不吃額度；
//     沒有反問在先的修正不收；一卦反問封頂；提示裡帶得到追問往來與上一問。

import { fakeDb } from "./fake-db.mts";
import { buildChart } from "../supabase/functions/_shared/core.ts";
import { followupInterpret, MAX_ASKS_PER_CAST } from "../supabase/functions/_shared/pipeline.ts";

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : (bad++, console.log("✗", n)); };

Deno.env.set("ANTHROPIC_API_KEY", "test");
let reply = "";
let lastPrompt = "";
globalThis.fetch = ((_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  lastPrompt = body.messages.map((m: { content: string }) => m.content).join("\n") +
    "\n" + body.system.map((b: { text: string }) => b.text).join("\n");
  return Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "text", text: reply }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  }), { status: 200 }));
}) as typeof fetch;

const chart = buildChart([7, 8, 7, 8, 7, 8], 2026, 10, 2, 10);
const db = fakeDb({
  profiles: [{ id: "u1", plan: "free", lingshi: 0 }],
  characters: [{ id: "daoshi_m", persona_prompt: "大師兄", name: "大師兄" }],
  casts: [{ id: "c1", user_id: "u1", character_id: "daoshi_m", question: "這份工作月底前有消息嗎", chart, reading: "月底前恐怕還沒有消息。",
    lines: [7, 8, 7, 8, 7, 8], yong_qin: "官鬼", yong_via_shi: false, yong_via_ying: false, category: "事業", due_date: null, followup_used: 0 }],
  free_quota: [],
});
const s = db._store as Record<string, Record<string, unknown>[]>;
const run = (q: string) => followupInterpret(db as never, { userId: "u1", castId: "c1", question: q });

// 1. 他帶出新事實 → 角色照答並反問（吃第一次免費額度）
reply = "你說的這點，跟我先前的理解不一樣。\n<due>null</due>\n<ask>你在意的是主管的人品，還是他對你的評價？</ask>\n<revise>null</revise>";
let r = await run("其實我比較在意主管") as Record<string, unknown>;
t("回 ok", r.kind === "ok");
t("反問接在答覆末尾", String(r.answer).endsWith("你在意的是主管的人品，還是他對你的評價？"));
t("反問只出現一次", String(r.answer).split("你在意的是主管").length === 2);
t("回傳 ask", r.ask === "你在意的是主管的人品，還是他對你的評價？");
t("這一次照常計費（吃免費額度）", r.waived === false && s.free_quota.length === 1);
t("存進 ask 欄", s.followups[0].ask === r.ask && s.followups[0].waived === false);

// 2. 他回答反問 → 不收費、不吃額度；修正收下
const quotaBefore = JSON.stringify(s.free_quota);
reply = "修正：原以為你問錄不錄取，其實你掛心的是主管。\n<due>null</due>\n<ask>null</ask>\n<revise>錄取與否→與主管的關係；結論改為可相處</revise>";
r = await run("在意他對我的評價") as Record<string, unknown>;
t("提示帶到上一問", lastPrompt.includes("【你上一答末尾問了他】你在意的是主管的人品"));
t("提示帶到追問往來", lastPrompt.includes("問：其實我比較在意主管"));
t("提示帶到修正時放寬用神的說明", lastPrompt.includes("修正範圍內放寬"));
t("回答反問不收費", r.waived === true && r.paid === 0);
t("不吃當日免費額度", JSON.stringify(s.free_quota) === quotaBefore);
t("修正收下", r.revised === true && s.followups[1].revision === "錄取與否→與主管的關係；結論改為可相處");
t("單卦追問數照樣累加", (s.casts[0].followup_used as number) === 2);

// 3. 沒有反問在先就冒出修正 → 不收（那是模型自己翻案）
reply = "還是一樣。\n<due>null</due>\n<ask>null</ask>\n<revise>某前提→另一前提</revise>";
r = await run("那月底呢") as Record<string, unknown>;
t("沒有反問在先的修正不收", r.revised === false && s.followups[2].revision === null);
t("沒有反問在先就照常計費", r.waived === false);

// 4. 反問封頂：已經問過 MAX 次就不再收新的反問
for (let k = 1; k < MAX_ASKS_PER_CAST; k++) {
  reply = `第${k + 1}問。\n<due>null</due>\n<ask>第${k + 1}個問題？</ask>\n<revise>null</revise>`;
  await run(`再問${k}`);
  reply = "好。\n<due>null</due>\n<ask>null</ask>\n<revise>null</revise>";
  await run(`回答${k}`);
}
reply = "超額。\n<due>null</due>\n<ask>還想問一個？</ask>\n<revise>null</revise>";
r = await run("最後一問") as Record<string, unknown>;
t("提示寫明不能再反問", lastPrompt.includes("這一卦已不能再反問"));
t("超過上限的反問不收", r.ask === null && !String(r.answer).includes("還想問一個"));
t("反問總數封頂", s.followups.filter((f) => f.ask).length === MAX_ASKS_PER_CAST);

console.log(`${ok} 過 / ${bad} 敗`);
if (bad) Deno.exit(1);
