// dev/keep-test.mts — 卦的保存期限與搜尋（_shared/keep.ts）測試。
//
// 規則本身在 SQL（0087），這裡驗的是 TS 這一側不把它講錯：
// 查不到就照無牒報（不能報成永久）、「剩 N 天」不多報、分頁游標只在滿頁時給。
// SQL 那一側的驗法：本機 postgres 跑 0087，對 cleanup_expired_casts／search_casts 餵測資。
//
// 跑法：node dev/keep-test.mts

import { normalizeSearchQuery, daysLeft, castKeepOf, searchCasts, FREE_KEEP_DAYS } from "../supabase/functions/_shared/keep.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

/** 只認 rpc 的假 db：照名字回預設好的結果，並記下收到的參數 */
function rpcDb(answers: Record<string, { data: unknown; error?: unknown }>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    // deno-lint-ignore no-explicit-any
    db: { rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve(answers[name] ?? { data: null, error: { message: "no rpc" } }); } } as any,
  };
}

await t("搜尋字串：去頭尾、壓空白、全形轉半形", () => {
  eq(normalizeSearchQuery("  工作　　感情 "), "工作 感情", "全形空白也算分隔");
  eq(normalizeSearchQuery("ＡＢＣ"), "ABC", "NFKC");
});
await t("搜尋字串：空的回 null、關鍵字最多五個、最長五十字", () => {
  eq(normalizeSearchQuery("   "), null, "空白");
  eq(normalizeSearchQuery(undefined), null, "沒給");
  eq(normalizeSearchQuery("a b c d e f g"), "a b c d e", "五個");
  eq(normalizeSearchQuery("字".repeat(80))!.length, 50, "五十字");
});

await t("剩幾天：向下取整、過期為 0、永久為 null", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  eq(daysLeft("2026-10-26T12:00:00Z", now), 10, "10.5 天報 10，不多報");
  eq(daysLeft("2026-10-15T00:00:00Z", now), 0, "已過期等清理");
  eq(daysLeft(null, now), null, "永久");
});

await t("保存天數：查不到照無牒報，不能報成永久", async () => {
  const { db } = rpcDb({ cast_keep_of: { data: null, error: { message: "function does not exist" } } });
  const k = await castKeepOf(db, "u");
  eq(k.days, FREE_KEEP_DAYS, "0087 未跑");
  const { db: db2 } = rpcDb({ cast_keep_of: { data: [] } });
  eq((await castKeepOf(db2, "u")).days, FREE_KEEP_DAYS, "沒有 profile");
});
await t("保存天數：藏往回 null（永久）、緩衝期帶截止日", async () => {
  const { db } = rpcDb({ cast_keep_of: { data: [{ keep_days: null, grace_until: "2026-11-05T00:00:00Z" }] } });
  const k = await castKeepOf(db, "u");
  eq(k.days, null, "永久");
  eq(k.graceUntil, "2026-11-05T00:00:00Z", "緩衝");
});

const hit = (i: number, expires: string | null) => ({
  id: "c" + i, question: "q" + i, digest: null, gua_ben: "乾為天", gua_bian: null, category: null,
  character_id: null, created_at: `2026-10-${String(10 - i).padStart(2, "0")}T00:00:00Z`, due_date: null,
  thread_id: null, verdict: null, kept: expires === null, expires_at: expires,
});

await t("搜尋：空字串不打資料庫", async () => {
  const { db, calls } = rpcDb({});
  const r = await searchCasts(db, "u", { q: "  " });
  eq(r.kind, "err", "回 err");
  eq(calls.length, 0, "沒有查詢");
});
await t("搜尋：滿頁才給 nextBefore，值是最後一筆的 created_at", async () => {
  const rows = [hit(1, null), hit(2, "2099-01-01T00:00:00Z")];
  const { db, calls } = rpcDb({ search_casts: { data: rows }, cast_keep_of: { data: [{ keep_days: 90, grace_until: null }] } });
  const r = await searchCasts(db, "u", { q: "工作", limit: 2 });
  if (r.kind !== "ok") throw new Error("應為 ok");
  eq(r.nextBefore, rows[1].created_at, "游標");
  eq(r.casts[0].daysLeft, null, "受保護的卦沒有倒數");
  ok((r.casts[1].daysLeft ?? 0) > 1000, "到期日換成天數");
  ok(!("expires_at" in r.casts[1]), "對外欄位是 expiresAt");
  eq(r.keep.freeDays, FREE_KEEP_DAYS, "附無牒天數給引導文案");
  eq(calls.find((c) => c.name === "search_casts")!.args.p_limit, 2, "limit 原樣");

  const { db: db2 } = rpcDb({ search_casts: { data: rows }, cast_keep_of: { data: [{ keep_days: 90, grace_until: null }] } });
  const r2 = await searchCasts(db2, "u", { q: "工作", limit: 30 });
  eq(r2.kind === "ok" && r2.nextBefore, null, "沒滿頁就沒有下一頁");
});
await t("搜尋：before 不是時間就丟掉、limit 夾在 1–50", async () => {
  const { db, calls } = rpcDb({ search_casts: { data: [] }, cast_keep_of: { data: [] } });
  await searchCasts(db, "u", { q: "x", before: "'; drop table casts; --", limit: 999 });
  const a = calls.find((c) => c.name === "search_casts")!.args;
  eq(a.p_before, null, "before");
  eq(a.p_limit, 50, "limit 上限");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
