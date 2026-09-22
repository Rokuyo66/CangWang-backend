// dev/pricing-test.mts — 靈石價目：兩份來源不能走散，價差不能再拉開。
//
// 這支盯三件事，每一件都不會在開發時出錯，只會在半年後安靜地出錯：
//
// 一、0059 的 insert 與 prices.ts 的 DEFAULTS 是同一組值。有人只改其中一邊時，
//     線上看起來完全正常（資料庫贏），但只要那張表還沒套用、或查詢失敗一次，
//     扣費就會跳回另一組數字——而沒有人會發現。
//
// 二、每顆靈石的真實成本，各出口之間的價差。價差就是套利：同一顆免費石倒進
//     最貴的出口能換到的東西，若是最便宜出口的兩倍，發出去的石頭就會自己
//     集中到那裡，真實平均成本會往最貴的那端滑。0059 把它壓到 1.1 倍以內。
//
// 三、簽到發石只有一份表。原本 interpret 與 webhook-tg 各寫一份，TG 那份是
//     網頁的 2.1 倍——同一個人挑在 TG 簽就多拿一倍，而兩份表沒有人是故意
//     寫成不一樣的。合併之後這條測試確保它不會再被拆開。
//
// 跑法：node dev/pricing-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { readFileSync } from "node:fs";
const { COST, SIGN_REWARDS, priceTable } = await import("../supabase/functions/_shared/prices.ts");
const { PLAN_CASTS, PLAN_FOLLOWUPS } = await import("../supabase/functions/_shared/services.ts");
const { PLAN_CHATS } = await import("../supabase/functions/_shared/chat.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const eq = (a: unknown, b: unknown, m: string) => {
  if (a !== b) throw new Error(`${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);
};

console.log("\n靈石價目\n");

console.log("— 資料庫與程式的預設值");
await t("0059 的每一列都與 prices.ts 的預設相符", () => {
  const sql = readFileSync("supabase/migrations/0059_lingshi_prices.sql", "utf8");
  // 0059 裡不只一個 insert（價目本體一段、朗讀另一段），全部都要收進來——
  // 只看第一段的話，後來加的價目會躲過這條檢查，而那正是最需要被盯住的。
  const bodies = [...sql.matchAll(/insert into lingshi_prices[\s\S]*?on conflict/g)];
  if (!bodies.length) throw new Error("在 0059 裡找不到 insert——它被改寫了？");
  const rows = bodies.flatMap((b) =>
    [...b[0].matchAll(/\('([a-z_]+)',\s*(\d+),/g)].map((m) => [m[1], Number(m[2])] as const));
  if (!rows.length) throw new Error("insert 解不出任何一列");
  const inSql = Object.fromEntries(rows);
  const inTs = priceTable();
  for (const [k, v] of Object.entries(inSql)) {
    if (!(k in inTs)) throw new Error(`資料庫有 ${k}，程式沒有——那一列永遠不會生效（refreshPrices 只認得 DEFAULTS 裡的鍵）`);
    eq(inTs[k as keyof typeof inTs], v, `${k} 兩邊不一致`);
  }
  for (const k of Object.keys(inTs)) {
    if (!(k in inSql)) throw new Error(`程式有 ${k}，0059 沒有——改價時不會有人想到要改它`);
  }
});

console.log("\n— 每顆靈石的真實成本（價差就是套利空間）");
// 每次呼叫的 AI 成本（NT$，由 0043 單價表推算：快取命中、匯率 32）。
// 這幾個數字會隨模型與匯率變——它們是這支測試的前提，不是被測的對象。
const TWD_PER_CALL: Record<string, number> = {
  extra_cast: 0.63, followup: 0.56, comment: 0.49, deepen: 2.13, chat: 0.07,
};
await t("最貴與最便宜的出口，每顆成本相差在 1.35 倍以內", () => {
  const per = Object.entries(TWD_PER_CALL).map(([k, twd]) => [k, twd / COST[k as keyof typeof COST]] as const);
  const sorted = [...per].sort((a, b) => a[1] - b[1]);
  const [loK, lo] = sorted[0], [hiK, hi] = sorted[sorted.length - 1];
  const spread = hi / lo;
  console.log(`     每顆：${sorted.map(([k, v]) => `${k} ${v.toFixed(3)}`).join("  ")}`);
  if (spread > 1.35) {
    throw new Error(
      `價差 ${spread.toFixed(1)}×（${hiK} ${hi.toFixed(3)}／顆 vs ${loK} ${lo.toFixed(3)}／顆）。\n` +
      `       免費石會集中兌到 ${hiK}，真實平均成本會往那一端滑。調 ${hiK} 的價或重算錨點。`);
  }
});
await t("沒有任何出口是免費的（價目全為正整數）", () => {
  for (const [k, v] of Object.entries(priceTable())) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${k} 的價目是 ${v}——非正整數會讓扣費變成免費或 NaN`);
  }
});

console.log("\n— 簽到發石");
await t("七日一循環，第七天是大獎", () => {
  eq(SIGN_REWARDS.length, 7, "循環長度");
  const last = SIGN_REWARDS[6][0];
  if (last <= Math.max(...SIGN_REWARDS.slice(0, 6).map((r) => r[0])))
    throw new Error("第七天不是最大的——七日循環的節奏點被抹平了");
});
await t("兩支 function 都不再各寫一份", () => {
  for (const f of ["supabase/functions/interpret/index.ts", "supabase/functions/webhook-tg/index.ts"]) {
    const src = readFileSync(f, "utf8");
    if (/const SIGN_REWARDS\s*[:=]/.test(src))
      throw new Error(`${f} 又自己宣告了一份 SIGN_REWARDS——兩份遲早會走散（上次差了 2.1 倍）`);
  }
});
await t("每月發石量在預算內", () => {
  // 用「最貴的出口」估，不用平均：發出去的石頭是使用者在挑怎麼花，
  // 而理性的花法就是倒進每顆最划算的那個出口。平均值會系統性低估這筆負債。
  const worst = Math.max(...Object.entries(TWD_PER_CALL)
    .map(([k, twd]) => twd / COST[k as keyof typeof COST]));
  const perMonth = SIGN_REWARDS.reduce((a, [ls]) => a + ls, 0) / 7 * 30;
  const twd = perMonth * worst;
  console.log(`     ${perMonth.toFixed(0)} 顆／月 × ${worst.toFixed(3)}／顆 ≈ NT$${twd.toFixed(1)}／人／月`);
  if (twd > 25) throw new Error(`每人每月 NT$${twd.toFixed(1)}——免費帳號那一側沒有收入抵這筆`);
});

console.log("\n— 各階的成本天花板 vs 售價");
// 【這一條是這支測試存在的主要理由】
//
// 每日額度住在三支檔案的三張表裡（PLAN_CASTS、PLAN_FOLLOWUPS、PLAN_CHATS），
// 售價住在資料庫。加一格額度是一行程式、看起來完全無害，而它可能剛好讓那一階的
// 成本天花板越過售價——然後那一階就變成「越重度的用戶虧越多」。
//
// 那種虧損不會叫：它看起來像留存很好。所以在這裡問一次。
await t("每一階的月成本天花板都不超過售價", () => {
  const sql = readFileSync("supabase/migrations/0058_plans_and_orders.sql", "utf8");
  const rows = [...sql.matchAll(/\('(guanwei|zhiji|cangwang)',\s*'[^']*',\s*(\d+),\s*(\d+),/g)]
    .map((m) => ({ id: m[1], twd: Number(m[2]), grant: Number(m[3]) }));
  if (rows.length !== 3) throw new Error(`在 0058 裡只解出 ${rows.length} 階——那段 insert 被改寫了？`);

  const signPerMonth = SIGN_REWARDS.reduce((a, [ls]) => a + ls, 0) / 7 * 30;
  // 每顆靈石的成本取「最貴的出口」，不取平均：石頭是使用者在挑怎麼花的。
  const perStone = Math.max(...Object.entries(TWD_PER_CALL)
    .map(([k, twd]) => twd / COST[k as keyof typeof COST]));
  // 朗讀（0059）：只有最高階有免費次數，一次 NT$4.16
  const freeReadings: Record<string, number> = { guanwei: 0, zhiji: 0, cangwang: 8 };

  const bad: string[] = [];
  for (const r of rows) {
    const ai = 30 * (PLAN_CASTS[r.id] * TWD_PER_CALL.extra_cast
                   + PLAN_FOLLOWUPS[r.id] * TWD_PER_CALL.followup
                   + PLAN_CHATS[r.id] * TWD_PER_CALL.chat);
    const ceiling = ai + (r.grant + signPerMonth) * perStone + freeReadings[r.id] * 4.16;
    const margin = r.twd - ceiling;
    console.log(`     ${r.id.padEnd(9)} ${PLAN_CASTS[r.id]}/${PLAN_FOLLOWUPS[r.id]}/${PLAN_CHATS[r.id]}` +
      `  天花板 ${ceiling.toFixed(0).padStart(4)}  售價 ${String(r.twd).padStart(4)}` +
      `  毛利 ${margin.toFixed(0).padStart(5)} (${(margin / r.twd * 100).toFixed(0)}%)`);
    if (margin < 0) bad.push(`${r.id}：天花板 ${ceiling.toFixed(0)} > 售價 ${r.twd}，用滿一個月虧 ${(-margin).toFixed(0)}`);
  }
  if (bad.length) {
    throw new Error(bad.join("\n       ") +
      "\n       改額度（PLAN_CASTS／PLAN_FOLLOWUPS／PLAN_CHATS）或改售價（0058 的 insert）。" +
      "\n       這種虧損不會叫——它看起來像留存很好。");
  }
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
