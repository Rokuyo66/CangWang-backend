// dev/whereabouts-test.mts — 三人在觀裡走動、隱藏支線的規則測試。
//
// 驗的是這一層答應過的事：
//   同一格內位置不變（觀堂看到他在廊下，點進去不會變灶房）；換格才換；
//   每人看到的不一樣；少去的地方真的少（約一成上下），而且只在它的時段出現；
//   支線要「人在那裡＋問到那件事」兩個條件都成立才算，每人每條只寄一封信；
//   表裡的正則寫壞了不能讓聊天壞掉；觀堂那支不透露哪一處是支線。
//
// 跑法：node dev/whereabouts-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  pickWhere, whereaboutsAll, tryHiddenFound, asksAbout, slotOf, bandOf, ROUTINE, PLACES, __resetQuestCache, type Quest,
} from "../supabase/functions/_shared/whereabouts.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.stack ?? e?.message ?? e)); });
}
function ok(c: unknown, m: string) { if (!c) throw new Error(m); }

const Q: Quest[] = [
  { id: "m_zaofang", character_id: "daoshi_m", place: "zaofang", doing: "在灶房", bands: "dzl", weight: 1.2, hint: "蒸糕", found_hint: null, ask_re: "灶|糕|在做什麼" },
  { id: "f_houyuan", character_id: "daoshi_f", place: "houyuan", doing: "在後院", bands: "de", weight: 1.2, hint: "練劍", found_hint: null, ask_re: "後院|劍" },
  { id: "c_cangjingge", character_id: "lingshou", place: "cangjingge", doing: "在藏經閣", bands: "anl", weight: 1.2, hint: "趴書", found_hint: null, ask_re: "書|藏經" },
];
// 台北 2026-09-28 某小時的時間戳
const at = (h: number, m = 0, day = 28) => Date.UTC(2026, 8, day, h - 8, m);

console.log("\n位置\n");

await t("同一格內怎麼問都一樣", () => {
  for (const id of Object.keys(ROUTINE)) {
    const a = pickWhere("u1", id, Q, at(13, 0)), b = pickWhere("u1", id, Q, at(13, 59));
    ok(a && b && a.doing === b.doing, `${id} 同一格變了：${a?.doing} → ${b?.doing}`);
  }
});

await t("一天裡會換地方", () => {
  const seen = new Set<string>();
  for (let h = 0; h < 24; h += 2) seen.add(pickWhere("u1", "daoshi_m", Q, at(h))!.place);
  ok(seen.size >= 3, `師兄一天只去了 ${seen.size} 處`);
});

await t("每個人看到的不一樣", () => {
  const set = new Set<string>();
  for (let i = 0; i < 40; i++) set.add(pickWhere("u" + i, "daoshi_f", Q, at(10)).doing);
  ok(set.size >= 3, `四十個人都差不多：${[...set]}`);
});

await t("地點都有場景 key", () => {
  for (const [id, acts] of Object.entries(ROUTINE)) for (const a of acts) ok(PLACES[a.place], `${id} 的 ${a.place} 不在 PLACES`);
});

await t("每個時段每人都有地方去", () => {
  for (const id of Object.keys(ROUTINE)) for (let h = 0; h < 24; h += 2) ok(pickWhere("u1", id, [], at(h)), `${id} ${h} 點無處可去`);
});

await t("少去的地方：只在它的時段出現，機率約一成", () => {
  for (const q of Q) {
    let hit = 0, n = 0;
    for (let i = 0; i < 3000; i++) for (let h = 0; h < 24; h += 2) {
      const w = pickWhere("u" + i, q.character_id, Q, at(h, 0, 1 + (i % 28)))!;
      const inBand = q.bands.includes(bandOf(h));
      if (w.quest?.id === q.id) { ok(inBand, `${q.id} 出現在 ${h} 點（不在 ${q.bands}）`); hit++; }
      if (inBand) n++;
    }
    const p = hit / n;
    ok(p > 0.05 && p < 0.2, `${q.id} 在它的時段出現率 ${(p * 100).toFixed(1)}%`);
    console.log(`     ${q.id}：時段內 ${(p * 100).toFixed(1)}%`);
  }
});

await t("師兄平常不去灶房（只有支線那一處是灶房）", () => {
  for (let i = 0; i < 500; i++) for (let h = 0; h < 24; h += 2) {
    const w = pickWhere("u" + i, "daoshi_m", Q, at(h))!;
    if (w.place === "zaofang") ok(w.quest?.id === "m_zaofang", "灶房卻不是支線");
  }
});

console.log("\n隱藏支線\n");

// 找一個此刻正好在灶房的人
function someoneIn(qid: string, h: number) {
  const q = Q.find((x) => x.id === qid)!;
  for (let i = 0; i < 5000; i++) { const w = pickWhere("p" + i, q.character_id, Q, at(h)); if (w?.quest?.id === qid) return { uid: "p" + i, w }; }
  throw new Error("找不到在支線的人");
}
const seedDb = () => fakeDb({ hidden_quests: Q.map((q) => ({ ...q, active: true, mail_subject: "灶房的事", mail_body: "不必跟師妹說。", lingshi: 8 })) });

await t("在灶房＋問到 → 寄一封信夾 8 靈石", async () => {
  const db = seedDb(); const { uid, w } = someoneIn("m_zaofang", 7);
  const r = await tryHiddenFound(db as never, uid, w, "師兄你在做什麼？");
  ok(r && r.lingshi === 8 && r.mailId, "沒找到");
  const mails = (db as any)._store.mail;
  ok(mails.length === 1 && mails[0].character_id === "daoshi_m" && mails[0].lingshi === 8, "信不對");
});

await t("同一人第二次不再寄", async () => {
  const db = seedDb(); const { uid, w } = someoneIn("m_zaofang", 7);
  await tryHiddenFound(db as never, uid, w, "在做什麼");
  const r2 = await tryHiddenFound(db as never, uid, w, "糕好吃嗎");
  ok(r2 === null && (db as any)._store.mail.length === 1, "寄了第二封");
});

await t("人在灶房但沒問到 → 不算", async () => {
  const db = seedDb(); const { uid, w } = someoneIn("m_zaofang", 7);
  ok(await tryHiddenFound(db as never, uid, w, "今天天氣不錯") === null, "沒問也算");
});

await t("問到了但人不在那裡 → 不算", async () => {
  const db = seedDb();
  const w = pickWhere("x", "daoshi_m", [], at(10))!;   // 沒有支線可抽
  ok(await tryHiddenFound(db as never, "x", w, "在灶房做什麼") === null, "不在也算");
});

await t("表裡的正則寫壞了不炸", () => {
  ok(asksAbout({ ...Q[0], ask_re: "([" }, "在做什麼") === false, "應回 false");
});

await t("觀堂那支不透露支線", async () => {
  __resetQuestCache();
  const db = seedDb(); const { uid } = someoneIn("m_zaofang", 7);
  const r = await whereaboutsAll(db as never, uid, at(7));
  ok(r.chars.daoshi_m.place === "zaofang", "應在灶房");
  ok(!("quest" in r.chars.daoshi_m) && !JSON.stringify(r).includes("m_zaofang"), "露出支線 id");
  ok(Date.parse(r.endsAt) === at(8), `時格結束應是 8 點，得到 ${r.endsAt}`);
});

await t("時格：台北時間每兩小時", () => {
  ok(slotOf(at(0, 30)).slot === 0 && slotOf(at(23, 59)).slot === 11, "格號不對");
  ok(slotOf(at(1)).date === "2026-09-28", "日界應為台北");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
