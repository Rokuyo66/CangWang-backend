// dev/moderation-test.mts — 檢舉按鈕的編碼，與「分類清單有沒有跟資料庫走散」。
//
// 這一支測的兩件事都不會在開發時出錯，只會在線上出錯：
//
// 一、callback_data 有 64 bytes 硬上限，而一個 uuid 就佔 36。超過的話 Telegram
//     不會報錯，那顆按鈕就是按了沒反應——而你在本機永遠看不到，因為本機沒有
//     Telegram。所以長度要在這裡釘死。
//
// 二、檢舉分類在兩個地方各存一份：0057 的 check 約束（資料庫認什麼）與
//     notify-admin.ts 的 REASON_LABELS（介面顯示什麼）。兩邊走散的後果分兩種——
//     TS 多一個：使用者選得到，insert 被 check 打回，檢舉送不出去；
//     SQL 多一個：資料庫存得進去，推播顯示 undefined。
//     所以這裡直接去讀 migration 的原文比對，不靠人記得同步。
//
// 跑法：node dev/moderation-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { readFileSync } from "node:fs";
const { modCallback, parseModCallback, REASON_LABELS, esc } =
  await import("../supabase/functions/_shared/notify-admin.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);
};

const UUID = "3f2a91bc-7d64-4e88-9a0f-15c3ab7e2d40";

console.log("\n檢舉與下架\n");

console.log("— callback_data");
await t("四種組合都繞得回原樣", () => {
  for (const action of ["hide", "dismiss"] as const) {
    for (const type of ["post", "comment"] as const) {
      const r = parseModCallback(modCallback(action, type, UUID));
      if (!r) throw new Error(`${action}/${type} 解不回來`);
      eq(r.action, action, "action");
      eq(r.type, type, "type");
      eq(r.id, UUID, "id");
    }
  }
});

await t("長度在 Telegram 的 64 bytes 之內", () => {
  for (const action of ["hide", "dismiss"] as const) {
    for (const type of ["post", "comment"] as const) {
      const n = Buffer.byteLength(modCallback(action, type, UUID), "utf8");
      if (n > 64) throw new Error(`${action}/${type} 佔 ${n} bytes，超過 64——那顆鈕按了不會有反應`);
    }
  }
});

await t("認不得的 callback 一律回 null，不亂猜", () => {
  for (const bad of ["", "char:daoshi_m", "mh:p:不是uuid", "mh:x:" + UUID, "mz:p:" + UUID,
                     "mh:p:" + UUID + "extra", "mh:p", "MH:P:" + UUID]) {
    if (parseModCallback(bad) !== null) throw new Error(`「${bad}」不該被認成處理指令`);
  }
});

console.log("\n— 分類清單與資料庫是否一致");
await t("REASON_LABELS 與 0057 的 check 約束逐項相符", () => {
  const sql = readFileSync("supabase/migrations/0057_reports_and_blocks.sql", "utf8");
  const m = /reason\s+text not null check \(reason in \(([^)]*)\)\)/.exec(sql);
  if (!m) throw new Error("在 0057 裡找不到 reason 的 check 約束——它被改寫了？");
  const inSql = m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort();
  const inTs = Object.keys(REASON_LABELS).sort();
  const onlySql = inSql.filter((x) => !inTs.includes(x));
  const onlyTs = inTs.filter((x) => !inSql.includes(x));
  if (onlySql.length) throw new Error(`資料庫收得進去、介面卻沒有標籤（推播會顯示 undefined）：${onlySql.join("、")}`);
  if (onlyTs.length) throw new Error(`介面選得到、資料庫卻會打回（檢舉送不出去）：${onlyTs.join("、")}`);
  eq(inSql.length, 6, "分類數量");
});

await t("每個分類都有看得懂的中文標籤", () => {
  for (const [k, v] of Object.entries(REASON_LABELS)) {
    if (!v || !v.trim()) throw new Error(`${k} 沒有標籤`);
    if (/^[a-z_]+$/.test(v)) throw new Error(`${k} 的標籤是「${v}」——那是 key，不是給人看的字`);
  }
});

await t("自傷類在清單內（推播要據此標成優先）", () => {
  if (!REASON_LABELS.selfharm) throw new Error("selfharm 不在分類裡，優先標記會失效");
});

console.log("\n— 推播的 HTML 轉義");
await t("使用者寫的字不會弄壞整則訊息", () => {
  eq(esc("<b>假粗體</b>"), "&lt;b&gt;假粗體&lt;/b&gt;", "標籤");
  eq(esc("a & b"), "a &amp; b", "& 要先轉，否則會把後面轉好的再轉一次");
  eq(esc("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;", "腳本");
  eq(esc(""), "", "空字串");
  eq(esc(null as unknown as string), "", "null 不該變成字串 null");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
