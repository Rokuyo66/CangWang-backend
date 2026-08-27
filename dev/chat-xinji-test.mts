// dev/chat-xinji-test.mts — 閒聊接到心跡、再接到起卦的那一段。
//
// 驗的是這條路上會出事的地方：
//   ・擬題標記多了兩格（事由、一句話），舊稿與免費層漏格時不能整個擬題作廢；
//   ・「這件事你在記了」認的是與一事不二占同一個鍵（question_norm），不是模糊比對；
//   ・免費只記一件——記不下新的時要指得出一條現成的線，不能只丟一句「滿了」；
//   ・從閒聊開的線沒有卦，所以 question_norm 得由擬好的問句頂上，
//     否則他下一步真的去起卦，一事不二占會把他擋在門外（而他前一步才剛記下這件事）；
//   ・那段話的總結要落成這條線的第一則留言，且一條線只落一次。
//
// 跑法：node dev/chat-xinji-test.mts

import { fakeDb } from "./fake-db.mts";

// chat.ts 載入時就讀 Deno.env（模型名、金鑰、各種上限），node 沒有這個全域。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

const { parseMarks } = await import("../supabase/functions/_shared/chat.ts");
const { threadHint, topicOf, openThread, PLAN_THREADS } =
  await import("../supabase/functions/_shared/xinji.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.stack ?? e?.message ?? e)); });
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) =>
  ok(a === b, `${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
const P = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const E = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

console.log("\n擬題標記\n");

await t("四格都給時，事由與一句話都收得到", () => {
  const m = parseMarks("我替你理成一句。\n[[DRAFT|三個月內那筆尾款收得回來嗎？|null|那筆尾款|尾款拖了兩個月，對方一直說再等等，他不敢催。]]");
  eq(m.draft, "三個月內那筆尾款收得回來嗎？", "問句");
  eq(m.draftYong, null, "非感情卦不該取用神");
  eq(m.draftTopic, "那筆尾款", "事由");
  ok(m.draftGist?.startsWith("尾款拖了兩個月"), "一句話");
  eq(m.clean.includes("DRAFT"), false, "標記沒剝乾淨——絕不可讓它裸奔給人看");
});

await t("舊稿只有兩格照樣算擬題成功——多的那兩格是加分，不是前提", () => {
  const m = parseMarks("[[DRAFT|半年內與阿明能不能復合？|官鬼]]");
  eq(m.draft, "半年內與阿明能不能復合？", "問句該照收");
  eq(m.draftYong?.qin, "官鬼", "用神該照收");
  eq(m.draftTopic, null, "沒給就是沒給");
  eq(m.draftGist, null, "沒給就是沒給");
});

await t("模型在那兩格寫 null／無／破折號，一律當沒給——硬湊一個名字比空著更糟", () => {
  const m = parseMarks("[[DRAFT|這個月換工作能不能成？|null|null|—]]");
  eq(m.draft, "這個月換工作能不能成？", "問句");
  eq(m.draftTopic, null, "null 該當成沒給");
  eq(m.draftGist, null, "破折號該當成沒給");
});

await t("事由從問句裡切得出來（模型沒給時頂上的那一個）", () => {
  // 時間窗不是這件事的名字：三個月後這條線還在，名字裡卻寫著三個月內
  eq(topicOf("三個月內那筆尾款收得回來嗎？"), "那筆尾款收得回來", "時間窗該去掉");
  eq(topicOf("我這個月的財運如何？"), "財運", "去掉開頭的我、時間窗與句尾的問法");
  eq(topicOf("換工作會不會成？"), "換工作", "乾淨的那一種");
  ok(topicOf("字".repeat(40)).length <= 12, "再長也要收在十二字內");
});

console.log("\n這件事在心跡那邊\n");

/** 開一條線（直接寫庫，不走 openThread，免得測試互相牽動） */
async function seedThread(db: any, o: { title: string; subject?: string; norm?: string; status?: string }) {
  const { data } = await db.from("threads").insert({
    user_id: U, title: o.title, subject: o.subject ?? null, question_norm: o.norm ?? null,
    status: o.status ?? "open", opened_at: new Date().toISOString(), last_cast_at: null,
  }).select("id").single();
  return data.id as string;
}

await t("問句對上就是同一件事——認的是一事不二占那個鍵", async () => {
  const db = fakeDb() as any;
  const id = await seedThread(db, { title: "那筆尾款", norm: "三個月內那筆尾款收得回來嗎" });
  await db.from("casts").insert({ user_id: U, thread_id: id, question: "x" });
  await db.from("casts").insert({ user_id: U, thread_id: id, question: "y" });

  const h = await threadHint(db, U, "free", { question: "三個月內，那筆尾款收得回來嗎？" });
  eq(h.thread?.id, id, "沒認出是同一件事");
  eq(h.thread?.casts, 2, "問過幾次該數得出來");
});

await t("問句沒對上、事由對得上，也算同一件事", async () => {
  const db = fakeDb() as any;
  const id = await seedThread(db, { title: "阿凱這條線", subject: "阿凱" });
  const h = await threadHint(db, U, "free", { question: "半年內與阿凱能不能復合？", topic: "阿凱" });
  eq(h.thread?.id, id, "「阿凱」該對上「阿凱這條線」");
});

await t("兩邊都對不上就是新的一件事——寧可多開一條也不要歸錯", async () => {
  const db = fakeDb() as any;
  await seedThread(db, { title: "那筆尾款", norm: "尾款收得回來嗎" });
  const h = await threadHint(db, U, "zhiji", { question: "這個月換工作能不能成？", topic: "換工作" });
  eq(h.thread, null, "硬歸到別件事上了");
  eq(h.can_add, true, "知幾記得下第二件");
  eq(h.fallback, null, "還記得下就不必指路");
});

await t("了結的線不參與比對——它已經不在記了", async () => {
  const db = fakeDb() as any;
  await seedThread(db, { title: "那筆尾款", norm: "尾款收得回來嗎", status: "closed" });
  const h = await threadHint(db, U, "free", { question: "尾款收得回來嗎" });
  eq(h.thread, null, "了結的線被當成還在記");
  eq(h.open, 0, "了結的不該佔額度");
});

await t("免費只記一件：記不下新的時，要指得出一條現成的線", async () => {
  const db = fakeDb() as any;
  eq(PLAN_THREADS.free, 1, "免費 1 件");
  const id = await seedThread(db, { title: "那筆尾款" });
  const h = await threadHint(db, U, "free", { question: "這個月換工作能不能成？", topic: "換工作" });
  eq(h.can_add, false, "免費不該記得下第二件");
  eq(h.fallback?.id, id, "沒指路——只丟一句「滿了」是最沒用的擋法");
  eq(h.max, 1, "額度該照方案");
});

console.log("\n從閒聊記下這件事\n");

await t("沒有卦也開得起來，而且 question_norm 由擬好的問句頂上", async () => {
  const db = fakeDb() as any;
  const r = P(await openThread(db, U, "free", {
    title: "那筆尾款", question: "三個月內，那筆尾款收得回來嗎？",
    note: "尾款拖了兩個月，對方一直說再等等。", characterId: "daoshi_m",
  }));
  eq(r.thread.title, "那筆尾款", "名字");
  eq(r.thread.question_norm, "三個月內那筆尾款收得回來嗎", "正規化的問句沒存進去——他下一步就會被一事不二占擋住");

  // 存進去的鍵要與比對時算出來的是同一個
  const h = await threadHint(db, U, "free", { question: "三個月內，那筆尾款收得回來嗎？" });
  eq(h.thread?.id, r.thread.id, "存的鍵與比對的鍵對不上");
});

await t("那段話的總結落成這條線的第一則留言", async () => {
  const db = fakeDb() as any;
  const r = P(await openThread(db, U, "free", {
    title: "那筆尾款", question: "三個月內那筆尾款收得回來嗎？",
    note: "尾款拖了兩個月，對方一直說再等等。", characterId: "daoshi_m",
  }));
  const { data: notes } = await db.from("thread_notes").select("*").eq("thread_id", r.thread.id);
  eq(notes.length, 1, "總結沒留下");
  eq(notes[0].kind, "from_chat", "來源分不出來");
  eq(notes[0].character_id, "daoshi_m", "誰說的掉了");
  ok(notes[0].body.includes("兩個月"), "留言內容不對");
});

await t("沒有角色就不留言（留言必須有人說），但線照樣開得起來", async () => {
  const db = fakeDb() as any;
  const r = P(await openThread(db, U, "free", { title: "那筆尾款", note: "沒有人說的話" }));
  ok(r.thread.id, "線該開起來");
  const { data: notes } = await db.from("thread_notes").select("id").eq("user_id", U);
  eq(notes.length, 0, "沒有說話的人，不該憑空長出一則留言");
});

await t("免費額度滿了就開不了，而且要指得出路", async () => {
  const db = fakeDb() as any;
  P(await openThread(db, U, "free", { title: "那筆尾款", question: "尾款收得回來嗎" }));
  const msg = E(await openThread(db, U, "free", { title: "換工作", question: "換工作能不能成" }));
  ok(msg.includes("了結") || msg.includes("玉牒"), "擋下來時該指路，得到：" + msg);
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
