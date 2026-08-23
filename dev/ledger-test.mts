// dev/ledger-test.mts — 靈石收支的分組與明細測試。
//
// 驗的是「一列寫出來的東西是不是真的」：合計要對得起底下那幾筆、日界要跟站內其他
// 額度同一條線、展開看到的問句要真的是那筆扣款買到的東西。收支列表寫錯不會噴錯，
// 只會讓人以為自己被亂扣。
//
// 跑法：node dev/ledger-test.mts

import { fakeDb } from "./fake-db.mts";
import { groupLedger, ledgerDetails, taipeiDayOf, labelOf } from "../supabase/functions/_shared/ledger.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
/** 台北時間 → UTC ISO。測資照畫面上看到的時間寫，讀起來才對得上。 */
const tp = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00+08:00`).toISOString();

let nextId = 1;
const row = (action: string, amount: number, at: string, ref: string | null = null) =>
  ({ id: nextId++, action, amount, created_at: at, ref_id: ref });
/** 查詢是新→舊，測資也照這個順序餵 */
const desc = (rows: ReturnType<typeof row>[]) =>
  [...rows].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));

const noDetails = new Map();

console.log("\n靈石收支分組\n");

await t("同一天的閒聊收成一列：count 是筆數、amount 是合計", () => {
  const rows = desc([
    ...["20:18", "20:14", "20:13", "19:25", "19:24"].map((h) => row("chat", -1, tp("2025-08-18", h))),
  ]);
  const [day] = groupLedger(rows, noDetails);
  eq(day.date, "2025-08-18", "日期");
  eq(day.groups.length, 1, "同一天同一動作只該有一列");
  eq(day.groups[0].label, "閒聊", "項目名稱");
  eq(day.groups[0].count, 5, "筆數");
  eq(day.groups[0].amount, -5, "合計");
  eq(day.groups[0].items.length, 5, "展開後看得到每一筆");
});

await t("同一天不同項目各成一列，合計對得起底下每一筆", () => {
  const rows = desc([
    row("chat", -1, tp("2025-08-18", "20:18")),
    row("chat", -1, tp("2025-08-18", "17:12")),
    row("extra_cast", -10, tp("2025-08-18", "01:22")),
    row("extra_cast", -10, tp("2025-08-18", "01:22")),
    row("followup", -8, tp("2025-08-18", "19:03")),
    row("signin", 6, tp("2025-08-18", "09:00")),
  ]);
  const [day] = groupLedger(rows, noDetails);
  eq(day.groups.length, 4, "閒聊／加卦／追問／簽到各一列");
  const by = Object.fromEntries(day.groups.map((g) => [g.action, g]));
  eq(by.chat.amount, -2, "閒聊合計");
  eq(by.extra_cast.amount, -20, "加卦合計");
  eq(by.followup.amount, -8, "追問合計");
  eq(day.income, 6, "當天收入");
  eq(day.spend, -30, "當天支出");
  eq(day.net, -24, "當天淨額＝收入＋支出");
  eq(day.net, day.groups.reduce((s, g) => s + g.amount, 0), "淨額必須等於各列相加");
});

await t("跨日分開算，且日界走台北——01:22 屬於當天，不是前一天", () => {
  const rows = desc([
    row("extra_cast", -10, tp("2025-08-18", "01:22")),   // UTC 是 8/17 17:22
    row("chat", -1, tp("2025-08-17", "23:50")),
  ]);
  const days = groupLedger(rows, noDetails);
  eq(days.length, 2, "兩天");
  eq(days[0].date, "2025-08-18", "最近的一天排前面");
  eq(days[0].groups[0].action, "extra_cast", "01:22 那筆該落在 8/18");
  eq(days[1].date, "2025-08-17", "前一天");
  eq(taipeiDayOf(tp("2025-08-18", "01:22")), "2025-08-18", "台北 01:22 就是台北那天");
});

await t("順序：天與列都是最近的排前面，列內每一筆也是新→舊", () => {
  const rows = desc([
    row("chat", -1, tp("2025-08-18", "09:00")),
    row("extra_cast", -10, tp("2025-08-18", "20:00")),   // 當天最晚的一筆
    row("chat", -1, tp("2025-08-18", "19:00")),
  ]);
  const [day] = groupLedger(rows, noDetails);
  eq(day.groups[0].action, "extra_cast", "當天最後發生的項目排最前");
  eq(day.groups[1].items[0].at, tp("2025-08-18", "19:00"), "列內第一筆是最新的");
  eq(day.groups[1].items[1].at, tp("2025-08-18", "09:00"), "列內第二筆是較舊的");
});

await t("沒對照表的動作照原代號顯示，不會變成空白", () => {
  eq(labelOf("extra_cast"), "加卦", "有對照");
  eq(labelOf("something_new"), "something_new", "沒對照就照原樣，不吞掉");
});

console.log("\n收支明細（展開後看到的東西）\n");

await t("加卦展開看得到買到的是哪一卦", async () => {
  const db = fakeDb({ casts: [{ id: "cast-1", question: "這份工作還能做多久" }] });
  const rows = [row("extra_cast", -10, tp("2025-08-18", "01:22"), "cast-1")];
  const d = await ledgerDetails(db, rows);
  eq(d.get(rows[0].id)?.detail, "這份工作還能做多久", "明細＝那一卦問的事");
  eq(d.get(rows[0].id)?.ref, "cast-1", "帶得回卦 id，前端才點得進卦曆");
  eq(d.get(rows[0].id)?.refKind, "cast", "指向的是一支卦");
});

await t("追問展開看到的是追問那句，不是原卦問句", async () => {
  const db = fakeDb({
    casts: [{ id: "cast-1", question: "這份工作還能做多久" }],
    followups: [
      { cast_id: "cast-1", question: "那年底之前會有變動嗎", created_at: tp("2025-08-18", "19:03") },
      { cast_id: "cast-1", question: "換到別家會更好嗎", created_at: tp("2025-08-18", "20:11") },
    ],
  });
  const rows = desc([
    row("followup", -8, tp("2025-08-18", "19:03"), "cast-1"),
    row("followup", -8, tp("2025-08-18", "20:11"), "cast-1"),
  ]);
  const d = await ledgerDetails(db, rows);
  const at = (h: string) => d.get(rows.find((r) => r.created_at === tp("2025-08-18", h))!.id)?.detail;
  eq(at("19:03"), "那年底之前會有變動嗎", "19:03 那筆該配到當時問的那句");
  eq(at("20:11"), "換到別家會更好嗎", "20:11 那筆該配到當時問的那句");
});

await t("同一支卦的兩次追問不會共用同一句——先發生的先認領", async () => {
  // 兩筆扣款相隔一分鐘，兩句追問也相隔一分鐘：配錯的話會兩筆都指向同一句
  const db = fakeDb({
    casts: [{ id: "cast-1", question: "原卦問句" }],
    followups: [
      { cast_id: "cast-1", question: "第一問", created_at: tp("2025-08-18", "19:03") },
      { cast_id: "cast-1", question: "第二問", created_at: tp("2025-08-18", "19:04") },
    ],
  });
  const rows = desc([
    row("followup", -8, tp("2025-08-18", "19:03"), "cast-1"),
    row("followup", -8, tp("2025-08-18", "19:04"), "cast-1"),
  ]);
  const d = await ledgerDetails(db, rows);
  const got = rows.map((r) => d.get(r.id)?.detail).sort();
  eq(got.join("|"), "第一問|第二問", "兩筆該各認一句");
});

await t("追問配不到（當時 AI 失敗、沒入庫）就退回原卦問句，不憑空掰", async () => {
  const db = fakeDb({ casts: [{ id: "cast-1", question: "原卦問句" }], followups: [] });
  const rows = [row("followup", -8, tp("2025-08-18", "19:03"), "cast-1")];
  const d = await ledgerDetails(db, rows);
  eq(d.get(rows[0].id)?.detail, "原卦問句", "退回原卦問句");
});

await t("時間差太遠的追問不認：那是同一支卦另一天問的", async () => {
  const db = fakeDb({
    casts: [{ id: "cast-1", question: "原卦問句" }],
    followups: [{ cast_id: "cast-1", question: "三天後才問的那句", created_at: tp("2025-08-21", "19:03") }],
  });
  const rows = [row("followup", -8, tp("2025-08-18", "19:03"), "cast-1")];
  const d = await ledgerDetails(db, rows);
  eq(d.get(rows[0].id)?.detail, "原卦問句", "隔了三天就不該配上去");
});

await t("閒聊、簽到這種沒有對照物的，明細是空的而不是亂指", async () => {
  const db = fakeDb({});
  const rows = [row("chat", -1, tp("2025-08-18", "20:18")), row("signin", 6, tp("2025-08-18", "09:00"))];
  const d = await ledgerDetails(db, rows);
  for (const r of rows) {
    eq(d.get(r.id)?.detail, null, `${r.action} 不該有明細`);
    eq(d.get(r.id)?.ref, null, `${r.action} 不該指向任何東西`);
  }
});

await t("ref_id 指向的卦已被刪：明細留空，不整支炸掉", async () => {
  const db = fakeDb({ casts: [] });
  const rows = [row("extra_cast", -10, tp("2025-08-18", "01:22"), "cast-gone")];
  const d = await ledgerDetails(db, rows);
  ok(d.has(rows[0].id), "仍要有這一筆");
  eq(d.get(rows[0].id)?.detail, null, "查不到就留空");
});

await t("熱門獎勵展開看得到是哪一篇", async () => {
  const db = fakeDb({
    posts: [{ id: "post-1", title: "澤雷隨之水火既濟" }],
    post_comments: [{ id: "cmt-1", post_id: "post-1", body: "這卦我也起過" }],
  });
  const rows = [
    row("post_hot", 10, tp("2025-08-18", "12:00"), "post-1"),
    row("comment_hot", 5, tp("2025-08-18", "12:30"), "cmt-1"),
  ];
  const d = await ledgerDetails(db, rows);
  eq(d.get(rows[0].id)?.detail, "澤雷隨之水火既濟", "貼文標題");
  eq(d.get(rows[1].id)?.detail, "這卦我也起過", "回文內容");
  eq(d.get(rows[1].id)?.ref, "post-1", "回文要帶得回它所屬的貼文，點開才知道去哪");
});

await t("過長的問句截短，一列塞不下整段", async () => {
  const long = "我".repeat(80);
  const db = fakeDb({ casts: [{ id: "cast-1", question: long }] });
  const rows = [row("extra_cast", -10, tp("2025-08-18", "01:22"), "cast-1")];
  const d = await ledgerDetails(db, rows);
  const got = d.get(rows[0].id)!.detail!;
  ok(got.length < long.length, "應被截短");
  ok(got.endsWith("…"), "截短要看得出來還有後續");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
