// dev/events-test.mts — 道緣事件服務層的門檻測試。
//
// 內容搬到後端的重點不是「資料換個地方放」，是門檻真的擋得住。
// 清單頁把沒到道緣的章畫成灰的，那是給人看的；直接打 event_open 的人不看畫面。
// 這一支驗的就是那條線：畫面怎麼畫都行，scenes 沒過門檻就是拿不到。
//
// 跑法：node dev/events-test.mts

import { fakeDb } from "./fake-db.mts";
import { listEvents, openEvent } from "../supabase/functions/_shared/events.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) =>
  ok(a === b, `${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
const payloadOf = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const errOf = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

const SCENES = [{ bg: "guanmen", speaker: "大師兄", text: "「這麼晚。」" }];
const seed = () => ({
  character_events: [
    { id: "m_c1", character_id: "daoshi_m", chapter: 1, seq: 1, title: "代理",
      summary: "少了一冊。", require_favor: 0, require_event: null,
      scenes: SCENES, choices: [{ key: "a", label: "問" }], published: true },
    { id: "m_c2", character_id: "daoshi_m", chapter: 2, seq: 2, title: "缺頁",
      summary: "殘頁。", require_favor: 300, require_event: "m_c1",
      scenes: SCENES, choices: null, published: true },
    { id: "m_c3", character_id: "daoshi_m", chapter: 3, seq: 3, title: "他的名字",
      summary: "位置。", require_favor: 500, require_event: "m_c2",
      scenes: [], choices: null, published: true },
    { id: "m_draft", character_id: "daoshi_m", chapter: 9, seq: 9, title: "草稿",
      summary: "", require_favor: 0, require_event: null,
      scenes: SCENES, choices: null, published: false },
    { id: "f_c1", character_id: "daoshi_f", chapter: 1, seq: 1, title: "別人的章",
      summary: "", require_favor: 0, require_event: null,
      scenes: SCENES, choices: null, published: true },
  ],
  user_character: [] as any[],
  user_character_events: [] as any[],
});

console.log("\n道緣事件服務層\n");

await t("目錄只回自己角色、已發佈的章，依章序", async () => {
  const db = fakeDb(seed()) as any;
  const p = payloadOf(await listEvents(db, "daoshi_m"));
  eq(p.events.length, 3, "應有三章（草稿不算）");
  eq(p.events.map((e: any) => e.id).join(","), "m_c1,m_c2,m_c3", "章序不對");
  ok(!p.events.some((e: any) => e.id === "f_c1"), "撈到別的角色的章");
  ok(!p.events.some((e: any) => e.id === "m_draft"), "撈到未發佈的草稿");
});

await t("目錄不含任何一句台詞", async () => {
  const db = fakeDb(seed()) as any;
  const p = payloadOf(await listEvents(db, "daoshi_m"));
  const json = JSON.stringify(p);
  ok(!json.includes("這麼晚"), "台詞在清單裡就外流了");
  for (const e of p.events) eq("scenes" in e, false, "清單不該帶 scenes");
  eq(p.events[0].scene_count, 1, "第一章應是 1 幕");
  eq(p.events[2].scene_count, 0, "第三章還沒寫，應是 0 幕");
  eq(p.events[0].has_choices, true, "第一章有選項");
  eq(p.events[1].has_choices, false, "第二章沒有選項");
});

await t("道緣不夠就拿不到 scenes——畫面畫成什麼樣都一樣", async () => {
  const db = fakeDb(seed()) as any;
  db._store.user_character_events.push({ user_id: U, event_id: "m_c1", completed_at: new Date().toISOString() });
  eq(errOf(await openEvent(db, U, "m_c2")), "道緣未至", "道緣沒擋住");
  db._store.user_character.push({ user_id: U, character_id: "daoshi_m", favor: 300 });
  const p = payloadOf(await openEvent(db, U, "m_c2"));
  eq(p.event.scenes.length, 1, "道緣夠了卻拿不到幕");
});

await t("前一章沒了結就開不了下一章", async () => {
  const db = fakeDb(seed()) as any;
  db._store.user_character.push({ user_id: U, character_id: "daoshi_m", favor: 999 });
  eq(errOf(await openEvent(db, U, "m_c2")), "前一章尚未了結", "前置章沒擋住");
  // 只是看過、沒完成（completed_at 為 null）一樣不算
  db._store.user_character_events.push({ user_id: U, event_id: "m_c1", scene_idx: 3, completed_at: null });
  eq(errOf(await openEvent(db, U, "m_c2")), "前一章尚未了結", "看到一半也被當成走完了");
});

await t("未發佈的草稿、不存在的 id、還沒寫內容的章，各給各的理由", async () => {
  const db = fakeDb(seed()) as any;
  eq(errOf(await openEvent(db, U, "m_draft")), "查無此章", "草稿沒擋住");
  eq(errOf(await openEvent(db, U, "no_such")), "查無此章", "不存在的 id 沒擋住");
  eq(errOf(await openEvent(db, U, "")), "查無此章", "空 id 沒擋住");
  db._store.user_character.push({ user_id: U, character_id: "daoshi_m", favor: 999 });
  db._store.user_character_events.push(
    { user_id: U, event_id: "m_c1", completed_at: new Date().toISOString() },
    { user_id: U, event_id: "m_c2", completed_at: new Date().toISOString() });
  eq(errOf(await openEvent(db, U, "m_c3")), "此章尚未開放", "沒有幕的章應說「尚未開放」而不是別的");
});

await t("開得成的那一章不下發 rewards", async () => {
  const db = fakeDb(seed()) as any;
  const p = payloadOf(await openEvent(db, U, "m_c1"));
  eq("rewards" in p.event, false, "獎勵提早外流——那是 event_finish 才判定的");
  eq(p.event.id, "m_c1", "回錯章");
  eq(p.event.scenes[0].text, "「這麼晚。」", "幕的內容不對");
});

await t("查無角色的目錄回空陣列，不是錯誤", async () => {
  const db = fakeDb(seed()) as any;
  eq(payloadOf(await listEvents(db, "lingshou")).events.length, 0, "沒有章的角色應回空陣列");
  eq(errOf(await listEvents(db, "")), "缺角色", "空角色 id 應回錯");
});

await t("省略角色＝一次撈全部，依角色分組，同樣不含台詞", async () => {
  const db = fakeDb(seed()) as any;
  const p = payloadOf(await listEvents(db));
  ok(p.catalog, "應回 catalog");
  eq(Object.keys(p.catalog).sort().join(","), "daoshi_f,daoshi_m", "分組的角色不對");
  eq(p.catalog.daoshi_m.length, 3, "師兄應有三章");
  eq(p.catalog.daoshi_f.length, 1, "師妹應有一章");
  ok(!JSON.stringify(p).includes("這麼晚"), "台詞在目錄裡就外流了");
  ok(!p.catalog.daoshi_m.some((e: any) => e.id === "m_draft"), "撈到未發佈的草稿");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
