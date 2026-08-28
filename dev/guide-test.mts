// dev/guide-test.mts — 初次引導記號（profiles.guide_seen_at）的判定與寫入。
//
// 為什麼要測這一段：「每次登入都跳引導」是使用者唯一看得見的徵狀，而它可以來自
// 三個完全不同的原因——記號沒蓋上、記號被反覆覆蓋、profiles 那一列讀不到。
// 三者在畫面上一模一樣，在程式碼裡卻要分開處理，所以這裡逐條釘死。
//
// 跑法：node dev/guide-test.mts

// services.ts 載入時就會讀 Deno.env（模型名、額度預設值），node 沒有這個全域，
// 先擺一個只會回 undefined 的替身，讓它全部走預設值（同 billing-test.mts）。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { fakeDb } from "./fake-db.mts";
const { guideSeenOf, markGuideSeen } = await import("../supabase/functions/_shared/services.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) =>
  ok(a === b, `${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
const profOf = (db: any) => db._store.profiles.find((p: any) => p.id === U);

console.log("\n初次引導記號\n");

await t("全新帳號（沒有記號、也還沒問過卦）＝沒看過，引導要跳", async () => {
  const db = fakeDb({ profiles: [{ id: U, guide_seen_at: null }], casts: [] }) as any;
  eq(await guideSeenOf(db, U, null), false, "全新帳號不該被當成看過");
  eq(profOf(db).guide_seen_at, null, "只是判定，不該順手蓋記號");
});

await t("記號在就是看過，不必回頭查卦", async () => {
  const db = fakeDb({ profiles: [{ id: U, guide_seen_at: "2026-08-01T00:00:00.000Z" }], casts: [] }) as any;
  eq(await guideSeenOf(db, U, "2026-08-01T00:00:00.000Z"), true, "有記號卻說沒看過");
});

await t("記號掉了但已經問過卦＝看過，並且順手補蓋", async () => {
  const db = fakeDb({
    profiles: [{ id: U, guide_seen_at: null }],
    casts: [{ id: "c1", user_id: U }],
  }) as any;
  eq(await guideSeenOf(db, U, null), true, "問過卦的人不可能還停在第一次登入");
  ok(profOf(db).guide_seen_at, "補蓋沒寫進去——下次登入又會重講一次");
});

await t("別人的卦不算數", async () => {
  const db = fakeDb({
    profiles: [{ id: U, guide_seen_at: null }],
    casts: [{ id: "c1", user_id: "someone-else" }],
  }) as any;
  eq(await guideSeenOf(db, U, null), false, "數到別人的卦了");
});

await t("蓋記號是冪等的：第二次不覆蓋第一次的時間", async () => {
  const db = fakeDb({ profiles: [{ id: U, guide_seen_at: null }], casts: [] }) as any;
  eq((await markGuideSeen(db, U)).ok, true, "第一次就該蓋得上");
  const first = profOf(db).guide_seen_at;
  ok(first, "第一次沒寫進去");
  eq((await markGuideSeen(db, U)).ok, true, "已經蓋過不算失敗");
  eq(profOf(db).guide_seen_at, first,
    "時間被往前推了——日後『引導改版就依上次看的時間再放一次』會永遠不成立");
});

await t("這個 uid 根本沒有 profiles 列＝失敗，不可以回 ok", async () => {
  const db = fakeDb({ profiles: [], casts: [] }) as any;
  const r = await markGuideSeen(db, "no-such-user");
  eq(r.ok, false, "寫不進去卻回報成功，前端就以為記下了");
  eq(r.msg, "no_profile", "錯誤訊息要說得出是哪一種失敗");
});

await t("寫入被資料庫擋下來時如實回報（欄位不存在／migration 沒跑）", async () => {
  const db = fakeDb({ profiles: [{ id: U, guide_seen_at: null }] }) as any;
  const real = db.from;
  db.from = (table: string) => {
    const q = real(table);
    if (table === "profiles") {
      q.update = () => ({
        eq: () => ({ is: () => ({ select: () => Promise.resolve({
          data: null, error: { message: `column "guide_seen_at" does not exist` },
        }) }) }),
      });
    }
    return q;
  };
  const r = await markGuideSeen(db, U);
  eq(r.ok, false, "資料庫擋下來了卻回 ok");
  ok(String(r.msg).includes("guide_seen_at"), "緣由要帶得出來，否則線上查不出為什麼一直跳引導");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
