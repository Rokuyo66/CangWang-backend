// dev/collection-test.mts — 卦鑑（六十四卦收集）與獎勵頭像解鎖的測試。
//
// 驗的是一句承諾：「收過的卦永遠算數，領過的頭像永遠是你的。」
// 線上壞掉的正是這句——收集度會倒退（PostgREST 的 db-max-rows 把 casts 切掉、
// 刪一則問卦紀錄連著把那一卦抹掉），而收集度一倒退，玩家已經領到手、已經戴在身上的
// 獎勵頭像就在道籍換裝那一頁變回鎖頭。這幾條測試把那三個路口各堵一次。
//
// 跑法：node dev/collection-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  recordGua, collectedGua, syncGuaFromCasts, computeCollection, rewardState,
} from "../supabase/functions/_shared/collection.ts";
import { GUA_BY_UPPER } from "../supabase/functions/_shared/core.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "u1";
const QIAN = GUA_BY_UPPER["乾"];           // 天卦一行八卦
const cast = (i: number, gua_ben: string, extra: Record<string, unknown> = {}) => ({
  id: `c${String(i).padStart(5, "0")}`, user_id: U, gua_ben, gua_bian: null,
  category: "事業", created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(), ...extra,
});

console.log("\n卦鑑");

await t("收進卦鑑的是本卦與變卦兩支", async () => {
  const db = fakeDb();
  await recordGua(db, U, ["乾為天", "天雷無妄"]);
  const owned = await collectedGua(db, U);
  eq(owned.size, 2, "兩支都該收");
  ok(owned.has("天雷無妄"), "變卦也算一卦");
});

await t("重複起同一卦不會收成兩列", async () => {
  const db = fakeDb();
  await recordGua(db, U, ["乾為天"]);
  await recordGua(db, U, ["乾為天", null, undefined]);
  eq(db._store.gua_collection.length, 1, "同一人同一卦只有一列");
});

await t("刪卦不會把那一卦從卦鑑裡抹掉", async () => {
  const db = fakeDb({ casts: [cast(1, "天雷無妄")] });
  await syncGuaFromCasts(db, U);                       // 起卦當下已入鑑
  await db.from("casts").delete().eq("id", "c00001");  // 玩家把這則紀錄刪了
  const owned = await syncGuaFromCasts(db, U);
  ok(owned.has("天雷無妄"), "紀錄可以刪，收過的卦不能跟著消失");
});

await t("casts 超過 db-max-rows 也掃得到最後一卦", async () => {
  // 1200 筆——真的 PostgREST 只會回前 1000 筆，沒有分頁的話後面那 200 筆等於不存在。
  const rows = Array.from({ length: 1199 }, (_, i) => cast(i, "乾為天"));
  rows.push(cast(1199, "天雷無妄"));                    // 唯一一次起出這一卦，落在視窗外
  const db = fakeDb({ casts: rows });
  const flat = await db.from("casts").select("gua_ben").eq("user_id", U);
  eq(flat.data.length, 1000, "先確認替身真的會截（不截的話這條測試證明不了什麼）");
  const owned = await syncGuaFromCasts(db, U);
  ok(owned.has("天雷無妄"), "分頁掃完，第 1200 筆的卦也要在鑑裡");
});

await t("日運卦不入鑑", async () => {
  const db = fakeDb({ casts: [cast(1, "火天大有", { category: "日運" })] });
  const owned = await syncGuaFromCasts(db, U);
  eq(owned.size, 0, "每日免費送的今日氣象不該拿來刷收集進度");
});

await t("卦鑑表還沒建起來時，退回現算而不是變 0/64", async () => {
  // 部署順序搞反（函式先上、migration 後跑）不該讓所有人的卦鑑一夜歸零。
  const db = fakeDb({ casts: [cast(1, "乾為天"), cast(2, "天雷無妄")] });
  const broken = {
    ...db,
    from: (table: string) => table === "gua_collection"
      ? { select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "relation \"gua_collection\" does not exist" } }) }) }
      : db.from(table),
  };
  const { columns } = await computeCollection(broken as never, U);
  eq(columns[0].count, 2, "天卦那一行仍該算得出兩卦");
});

console.log("\n集滿與獎勵");

await t("集滿天卦一行 → r01 達成", async () => {
  const db = fakeDb();
  await recordGua(db, U, QIAN.slice(0, 7));
  const before = await computeCollection(db, U);
  eq(before.columns[0].count, 7, "先只有七卦");
  ok(!before.eligible.includes("r01"), "差一卦就還不算集滿");
  await recordGua(db, U, [QIAN[7]]);
  const after = await computeCollection(db, U);
  ok(after.columns[0].done && after.eligible.includes("r01"), "八卦到齊才達成 r01");
});

await t("領過的頭像不會因為收集度變動被鎖回去", async () => {
  // 這就是線上那個 bug：unlocked 曾是「集滿 ∩ 已領」，收集度一退，
  // 已經戴在身上的頭像在道籍換裝那一頁變成鎖頭。
  const s = rewardState([], ["r01"]);
  ok(s.unlocked.includes("r01"), "領過就是玩家的，與當下集滿狀態無關");
  eq(s.claimable.length, 0, "已領的不該再出現在待領裡");
});

await t("集滿但未領 → 待領；領了就進已解鎖", async () => {
  const s1 = rewardState(["r01", "r04"], []);
  eq(s1.claimable.join(","), "r01,r04", "兩個都待領");
  const s2 = rewardState(["r01", "r04"], ["r01"]);
  eq(s2.unlocked.join(","), "r01", "已領的一個");
  eq(s2.claimable.join(","), "r04", "剩下那個還在待領");
});

await t("全 64 卦 → 三個最終獎勵一起達成", async () => {
  const db = fakeDb();
  await recordGua(db, U, Object.values(GUA_BY_UPPER).flat());
  const { allDone, eligible } = await computeCollection(db, U);
  ok(allDone, "六十四卦到齊");
  for (const k of ["r11", "r12", "r13"]) ok(eligible.includes(k), `最終獎勵 ${k} 該達成`);
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
