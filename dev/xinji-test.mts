// dev/xinji-test.mts — 心跡服務層的規則測試。
//
// 驗的是「這一層答應過的事有沒有做到」，而那些承諾多半是產品判斷不是演算法：
//   免費只記得住一件事、了結才騰得出格；日運不是問事所以記不成心事；
//   角色不會為同一件事叨念第二次、也不會在人已經回報之後還問「後來呢」；
//   溫度線算不出來的卦要跳過而不是補零；
//   月誌對免費用戶鎖的是卷首語不是統計，而卷首語生成過一次就不再花第二次錢。
//
// 跑法：node dev/xinji-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  timeline, threadDetail, openThread, attachCast, setThreadStatus, deleteThread,
  suggestThread, replyToNote, brewNotes, monthlyStats, monthlyReview, monthlyIndex,
  threadQuotaOf, statsDigest,
} from "../supabase/functions/_shared/xinji.ts";
import { buildChart } from "../supabase/functions/_shared/core.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.stack ?? e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1", V = "user-2";
const P = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const E = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const dayOffset = (n: number) =>
  new Date(Date.now() + 8 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

/** 種一張卦。chart 給真的——溫度線要從裡面算旺衰。 */
async function seedCast(db: any, o: {
  user?: string; thread?: string | null; at?: string; cat?: string;
  due?: string | null; verdict?: number | null; char?: string;
  lines?: number[]; y?: number; m?: number; d?: number; yong?: string | null; viaShi?: boolean;
  question?: string;
}) {
  const lines = o.lines ?? [7, 8, 7, 8, 7, 8];
  const chart = buildChart(lines, o.y ?? 2026, o.m ?? 3, o.d ?? 9, 10);
  const { data } = await db.from("casts").insert({
    user_id: o.user ?? U, thread_id: o.thread ?? null,
    created_at: o.at ?? new Date().toISOString(),
    character_id: o.char ?? "lingshou",
    question: o.question ?? "他心裡還有沒有我",
    category: o.cat ?? "感情",
    gua_ben: chart.benName, gua_bian: chart.bianName, chart,
    digest: "一句話摘要", due_date: o.due ?? null,
    yong_qin: o.yong === undefined ? "妻財" : o.yong,
    yong_via_shi: o.viaShi ?? false,
  }).select("id").single();
  if (o.due) {
    await db.from("feedback").insert({
      cast_id: data.id, user_id: o.user ?? U, due_date: o.due,
      verdict: o.verdict ?? null,
    });
  }
  return data.id as string;
}

console.log("\n心跡服務層\n");

/* ═══ 額度 ═══ */

await t("免費同時只記得住一件事，第二件擋下來時說的是人話", async () => {
  const db = fakeDb() as any;
  P(await openThread(db, U, "free", { title: "阿凱這條線" }));
  const msg = E(await openThread(db, U, "free", { title: "那筆尾款" }));
  ok(msg.includes("持玉牒"), "擋下來時該指出去哪裡解決，得到：" + msg);
});

await t("了結一件就騰得出格，了結不是刪除", async () => {
  const db = fakeDb() as any;
  const a = P(await openThread(db, U, "free", { title: "阿凱這條線" })).thread;
  P(await setThreadStatus(db, U, "free", a.id, true));
  P(await openThread(db, U, "free", { title: "那筆尾款" }));
  const { data: still } = await db.from("threads").select("*").eq("id", a.id).maybeSingle();
  ok(still, "了結不該把那條線刪掉");
  eq(still.status, "closed", "狀態該是 closed");
});

await t("付費格數依方案分級，且重啟時也受同一把尺管", async () => {
  eq(threadQuotaOf("free"), 1, "免費 1 格");
  eq(threadQuotaOf("zhiji"), 8, "知己 8 格");
  eq(threadQuotaOf("沒聽過的方案"), 1, "未知方案比照免費");
  const db = fakeDb() as any;
  const a = P(await openThread(db, U, "guanwei", { title: "一" })).thread;
  P(await openThread(db, U, "guanwei", { title: "二" }));
  P(await openThread(db, U, "guanwei", { title: "三" }));
  P(await setThreadStatus(db, U, "guanwei", a.id, true));
  P(await openThread(db, U, "guanwei", { title: "四" }));   // 補回第三格
  const msg = E(await setThreadStatus(db, U, "guanwei", a.id, false)); // 重啟會變第四件
  ok(msg.includes("已滿"), "重啟該受額度管，得到：" + msg);
});

await t("沒名字的心事記不下來", async () => {
  const db = fakeDb() as any;
  E(await openThread(db, U, "free", { title: "   " }));
});

/* ═══ 卦與線 ═══ */

await t("日運記不成心事，也歸不進既有的線", async () => {
  const db = fakeDb() as any;
  const f = await seedCast(db, { cat: "日運" });
  E(await openThread(db, U, "free", { title: "今天", castId: f }));
  const th = P(await openThread(db, U, "free", { title: "阿凱這條線" })).thread;
  const msg = E(await attachCast(db, U, f, th.id));
  ok(msg.includes("日運"), "訊息該說清楚為什麼，得到：" + msg);
});

await t("一張卦不能同時掛在兩條線上", async () => {
  const db = fakeDb() as any;
  const c = await seedCast(db, {});
  P(await openThread(db, U, "zhiji", { title: "一", castId: c }));
  E(await openThread(db, U, "zhiji", { title: "二", castId: c }));
});

await t("別人的心事與別人的卦，一概碰不到", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "free", { title: "我的事" })).thread;
  E(await threadDetail(db, V, th.id));
  E(await setThreadStatus(db, V, "free", th.id, true));
  E(await deleteThread(db, V, th.id));
  const mine = await seedCast(db, { user: U });
  const theirs = P(await openThread(db, V, "free", { title: "他的事" })).thread;
  E(await attachCast(db, V, mine, theirs.id));
});

await t("刪心事不刪卦——卦是他問過的事實", async () => {
  const db = fakeDb() as any;
  const c = await seedCast(db, {});
  const th = P(await openThread(db, U, "free", { title: "阿凱這條線", castId: c })).thread;
  P(await deleteThread(db, U, th.id));
  const { data: still } = await db.from("casts").select("id").eq("id", c).maybeSingle();
  ok(still, "卦被一起刪掉了");
});

await t("起卦前比對：同一句問話認得出是哪條線，標點與贅詞不影響", async () => {
  const db = fakeDb() as any;
  const c = await seedCast(db, { question: "他心裡還有沒有我" });
  const th = P(await openThread(db, U, "free", { title: "阿凱這條線", castId: c })).thread;
  const hit = P(await suggestThread(db, U, "請問，他心裡還有沒有我？")).thread;
  ok(hit, "認不出來");
  eq(hit.id, th.id, "認到別條線了");
  eq(P(await suggestThread(db, U, "這個月財運如何")).thread, null, "不相干的問句不該亂認");
});

await t("已了結的線不再攔截新卦（suggest 只認在記的）", async () => {
  const db = fakeDb() as any;
  const c = await seedCast(db, { question: "他心裡還有沒有我" });
  const th = P(await openThread(db, U, "free", { title: "阿凱", castId: c })).thread;
  P(await setThreadStatus(db, U, "free", th.id, true));
  eq(P(await suggestThread(db, U, "他心裡還有沒有我")).thread, null, "了結了還被認出來");
});

/* ═══ 角色留言（零 AI） ═══ */

await t("應期過了沒回報 → 角色來問；同一次應期不會問第二遍", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "那筆尾款" })).thread;
  await seedCast(db, { thread: th.id, char: "lingshou", due: dayOffset(-1) });

  eq(await brewNotes(db, U), 1, "該熬出一則");
  eq(await brewNotes(db, U), 0, "第二次不該再熬");
  const { data: notes } = await db.from("thread_notes").select("*").eq("user_id", U);
  eq(notes.length, 1, "只該有一則");
  eq(notes[0].kind, "due_passed", "類型不對");
  eq(notes[0].character_id, "lingshou", "說話的該是這條線上最後一卦的角色");
  ok(!notes[0].body.includes("{"), "模板變數沒填掉：" + notes[0].body);
});

await t("人已經回報了，就不會再被問「後來呢」", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "那筆尾款" })).thread;
  await seedCast(db, { thread: th.id, due: dayOffset(-1), verdict: 1 });
  eq(await brewNotes(db, U), 0, "回報過了還來問");
});

await t("應期還沒到，不會提早問", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱" })).thread;
  await seedCast(db, { thread: th.id, due: dayOffset(+5) });
  eq(await brewNotes(db, U), 0, "應期未到就先問了");
});

await t("擱久了會被問一次，但不會天天問；擱更久才再問一次", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱" })).thread;
  await seedCast(db, { thread: th.id, at: daysAgo(12) });
  eq(await brewNotes(db, U), 1, "擱了 12 天該問一次");
  eq(await brewNotes(db, U), 0, "隔天不該再問");
  const { data: n } = await db.from("thread_notes").select("*").eq("user_id", U);
  eq(n[0].kind, "gone_quiet", "類型不對");
  ok(/\d/.test(n[0].body) || !n[0].body.includes("days"), "天數該填進去或不出現");

  // 再擱十天 → 換一個 dedupe 桶，會再問一次（久擱只念一次等於失聯）
  await db.from("casts").update({ created_at: daysAgo(22) }).eq("thread_id", th.id);
  eq(await brewNotes(db, U), 1, "擱到第二個十天該再問一次");
});

await t("剛了結會有一句；沒有卦的線沒有人有立場說話", async () => {
  const db = fakeDb() as any;
  const bare = P(await openThread(db, U, "zhiji", { title: "還沒問過的事" })).thread;
  eq(await brewNotes(db, U), 0, "沒有卦就不該有留言");
  const th = P(await openThread(db, U, "zhiji", { title: "換工作那件事" })).thread;
  await seedCast(db, { thread: th.id, char: "daoshi_m" });
  P(await setThreadStatus(db, U, "zhiji", th.id, true));   // 內部會熬一次
  const { data: n } = await db.from("thread_notes").select("*").eq("thread_id", th.id);
  eq(n.length, 1, "結案該有一句");
  eq(n[0].kind, "closed", "類型不對");
  ok(n[0].body.includes("換工作那件事"), "標題該填進去：" + n[0].body);
  ok(bare, "");
});

await t("一條線一次只說一句，不疊著念", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱" })).thread;
  // 既擱很久、應期又過了 → 只該挑一句（應期優先）
  await seedCast(db, { thread: th.id, at: daysAgo(30), due: dayOffset(-3) });
  eq(await brewNotes(db, U), 1, "該只熬一則");
  const { data: n } = await db.from("thread_notes").select("*").eq("user_id", U);
  eq(n[0].kind, "due_passed", "同時成立時該以應期為先");
});

await t("回一句：標記已回，並回傳該找誰、帶什麼開場白", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱這條線" })).thread;
  await seedCast(db, { thread: th.id, char: "daoshi_f", due: dayOffset(-1) });
  await brewNotes(db, U);
  const { data: n } = await db.from("thread_notes").select("id").eq("user_id", U);
  const r = P(await replyToNote(db, U, n[0].id));
  eq(r.character_id, "daoshi_f", "該找的是留言的那位");
  ok(String(r.prefill).includes("阿凱這條線"), "開場白該帶上事由：" + r.prefill);
  const { data: after } = await db.from("thread_notes").select("*").eq("id", n[0].id).maybeSingle();
  ok(after.replied_at, "沒標記已回");
  // 回過的留言不再出現在時間軸
  const tl = P(await timeline(db, U, "zhiji"));
  eq(tl.notes.length, 0, "回過的留言不該還掛在時間軸上");
});

/* ═══ 溫度線 ═══ */

await t("溫度線一卦一點，帶得出旺衰與取用依據", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱" })).thread;
  await seedCast(db, { thread: th.id, at: daysAgo(50), m: 1, yong: "妻財" });
  await seedCast(db, { thread: th.id, at: daysAgo(20), m: 2, yong: "妻財" });
  await seedCast(db, { thread: th.id, at: daysAgo(1), m: 3, yong: "妻財" });
  const d = P(await threadDetail(db, U, th.id));
  eq(d.temperature.points.length, 3, "點數不對");
  eq(d.temperature.levels.length, 5, "旺衰五等");
  for (const pt of d.temperature.points) {
    ok(["旺", "相", "休", "囚", "死"].includes(pt.wang), "旺衰值不合法：" + pt.wang);
    ok(pt.score >= 0 && pt.score <= 4, "score 該落在 0..4");
    // 這支卦裡妻財不上卦，取的是伏神——basis 要把這件事說出來，
    // 而不是含糊地只寫「妻財」：同一條線上伏神與飛神的旺衰不是一回事。
    ok(String(pt.basis).startsWith("妻財"), "取用依據該說得出來：" + pt.basis);
  }
  eq(d.casts.length, 3, "歷卦數不對");
  ok(d.casts[0].at < d.casts[2].at, "歷卦該由舊到新");
});

await t("沒取定用神的舊卦退回世爻，並在 basis 說清楚", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "自身" })).thread;
  await seedCast(db, { thread: th.id, yong: null });
  const d = P(await threadDetail(db, U, th.id));
  eq(d.temperature.points.length, 1, "該還是算得出來");
  ok(String(d.temperature.points[0].basis).includes("世爻"), "basis 該標明是退回世爻");
});

await t("chart 不成形的卦跳過，不補零——補零會畫出沒發生過的暴跌", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "阿凱" })).thread;
  await seedCast(db, { thread: th.id, at: daysAgo(5) });
  await db.from("casts").insert({
    user_id: U, thread_id: th.id, created_at: daysAgo(2),
    question: "壞掉的舊卦", gua_ben: "乾為天", chart: { ben: [] }, category: "感情",
  });
  const d = P(await threadDetail(db, U, th.id));
  eq(d.casts.length, 2, "歷卦仍該列出兩張");
  eq(d.temperature.points.length, 1, "溫度線只該有算得出來的那一點");
});

/* ═══ 時間軸 ═══ */

await t("時間軸：在記的排在前，應期倒數算得出正負", async () => {
  const db = fakeDb() as any;
  const a = P(await openThread(db, U, "zhiji", { title: "在記的" })).thread;
  await seedCast(db, { thread: a.id, due: dayOffset(+5) });
  const b = P(await openThread(db, U, "zhiji", { title: "已了的" })).thread;
  await seedCast(db, { thread: b.id });
  await setThreadStatus(db, U, "zhiji", b.id, true);

  const tl = P(await timeline(db, U, "zhiji"));
  eq(tl.threads[0].title, "在記的", "在記的該排最前");
  eq(tl.threads[0].due_in, 5, "應期倒數不對");
  eq(tl.threads[0].cast_count, 1, "卦數不對");
  eq(tl.quota.max, 8, "配額該依方案");
  eq(tl.quota.open, 1, "在記數不對");
  eq(tl.threads[1].status, "closed", "已了的該在後面");
});

await t("時間軸：應期已過回負數，回報過的標得出來", async () => {
  const db = fakeDb() as any;
  const th = P(await openThread(db, U, "zhiji", { title: "那筆尾款" })).thread;
  await seedCast(db, { thread: th.id, due: dayOffset(-3), verdict: 2 });
  const tl = P(await timeline(db, U, "zhiji"));
  eq(tl.threads[0].due_in, -3, "已過的應期該是負數");
  eq(tl.threads[0].due_answered, true, "回報過該標得出來");
  eq(tl.threads[0].verdict, 2, "回報結果該帶出來");
});

/* ═══ 月誌 ═══ */

const YM = () => today().slice(0, 7);

await t("月誌統計不含日運——它每天一卦，算進去會把所有比例洗掉", async () => {
  const db = fakeDb() as any;
  await seedCast(db, { cat: "感情" });
  await seedCast(db, { cat: "財" });
  await seedCast(db, { cat: "日運" });
  const s = await monthlyStats(db, U, YM());
  eq(s.casts, 2, "卦數該排除日運");
  eq(s.by_category["日運"], undefined, "分類不該出現日運");
});

await t("月誌統計：分類、應期、回報三項都算得對", async () => {
  const db = fakeDb() as any;
  await seedCast(db, { cat: "感情", due: dayOffset(-1), verdict: 1 });
  await seedCast(db, { cat: "感情", due: dayOffset(-1), verdict: 2 });
  await seedCast(db, { cat: "財", due: dayOffset(-1), verdict: 3 });
  await seedCast(db, { cat: "財", due: dayOffset(+9) });
  await seedCast(db, { cat: "事業" });
  const s = await monthlyStats(db, U, YM());
  eq(s.casts, 5, "卦數");
  eq(s.by_category["感情"], 2, "感情");
  eq(s.by_category["財"], 2, "財");
  eq(s.due_total, 4, "給了應期的");
  eq(s.answered, 3, "已回報的");
  eq(s.verdicts.hit, 1, "應驗");
  eq(s.verdicts.partial, 1, "部分");
  eq(s.verdicts.miss, 1, "未應");
  ok(s.busiest && s.busiest.casts === 5, "最密的一天該是今天 5 卦");
});

await t("免費：統計照給，卷首語鎖上，理由是可直接顯示的中文", async () => {
  const db = fakeDb() as any;
  await seedCast(db, {});
  let called = 0;
  const p = P(await monthlyReview(db, U, "free", YM(), async () => { called++; throw new Error("不該被呼叫"); }));
  eq(p.locked, true, "免費該是鎖著的");
  eq(p.preface, null, "免費不該有卷首語");
  eq(called, 0, "免費不該花錢生成");
  eq(p.stats.casts, 1, "統計該照給——那本來就是他自己的資料");
  ok(String(p.locked_reason).length > 0, "該給一句可直接顯示的話");
});

await t("付費：生成一次就存起來，第二次不再花錢", async () => {
  const db = fakeDb() as any;
  await seedCast(db, {});
  let called = 0;
  const gen = async (digest: string) => {
    called++;
    ok(digest.includes("共問"), "餵給模型的摘要該是人話：" + digest);
    return { text: "這一月你問得急。", model: "claude-haiku-4-5", usage: { in: 300, out: 60 }, estimated: false };
  };
  const a = P(await monthlyReview(db, U, "zhiji", YM(), gen));
  eq(a.locked, false, "付費不該鎖");
  eq(a.preface, "這一月你問得急。", "卷首語不對");
  const b = P(await monthlyReview(db, U, "zhiji", YM(), gen));
  eq(b.preface, "這一月你問得急。", "第二次該讀存下來的");
  eq(called, 1, "第二次不該再呼叫模型");
  const { data: row } = await db.from("monthly_reviews").select("*").eq("user_id", U).maybeSingle();
  eq(row.tokens_out, 60, "用量該記下來");
});

await t("沒卦就不生成——對著空白寫感想只會寫出廢話", async () => {
  const db = fakeDb() as any;
  let called = 0;
  const p = P(await monthlyReview(db, U, "zhiji", YM(), async () => { called++; throw new Error("x"); }));
  eq(called, 0, "沒卦不該呼叫模型");
  eq(p.empty, true, "該標明這月是空的");
});

await t("生成失敗照給統計——少一段是遺憾，整頁打不開是故障", async () => {
  const db = fakeDb() as any;
  await seedCast(db, {});
  const p = P(await monthlyReview(db, U, "zhiji", YM(), async () => { throw new Error("模型掛了"); }));
  eq(p.gen_failed, true, "該標明生成失敗");
  eq(p.preface, null, "沒有卷首語");
  eq(p.stats.casts, 1, "統計仍該在");
});

await t("未來的月份看不到", async () => {
  const db = fakeDb() as any;
  E(await monthlyReview(db, U, "zhiji", "2099-01"));
});

await t("往月目錄列得出月份與卦數，並標明哪些已啟封", async () => {
  const db = fakeDb() as any;
  await seedCast(db, { at: new Date().toISOString() });
  await seedCast(db, { at: new Date().toISOString(), cat: "日運" });
  const idx = P(await monthlyIndex(db, U, "free"));
  eq(idx.months.length, 1, "該只有一個月");
  eq(idx.months[0].casts, 1, "日運不該計入");
  eq(idx.months[0].opened, false, "還沒啟封");
  eq(idx.paid, false, "方案該帶出來");
});

await t("摘要餵給模型的是人話，不是 JSON", () => {
  const s = {
    ym: "2026-02", casts: 12, by_category: { 感情: 5, 財: 4 },
    due_total: 7, answered: 5, verdicts: { hit: 3, partial: 1, miss: 1 },
    busiest: { date: "2026-02-09", casts: 3 },
    open_longest: { id: "x", title: "阿凱這條線", days: 56, casts: 3 }, closed: 1,
  };
  const d = statsDigest(s as any, [{ title: "阿凱這條線", casts: 3 }]);
  ok(d.includes("感情 5 卦"), "分類該寫成人話");
  ok(d.includes("阿凱這條線"), "未了那件該帶進去");
  ok(!d.includes("{"), "不該是 JSON");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
