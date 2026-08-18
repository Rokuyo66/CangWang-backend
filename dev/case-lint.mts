// dev/case-lint.mts — 案件檔檢查器。
//
// 兩段：
//   ① 結構驗證：id 重複、線索無取得途徑、前置成環、角色搜不到自己該拿的線索……
//      這類錯誤在遊玩時表現為「玩家卡死但沒有報錯」，不靠工具抓不出來。
//   ② 文本槽覆蓋：用固定種子的真隨機起卦跑出各 (區, 代價) 組合的實際機率，
//      排出必填順序，並算出「目前已填的槽覆蓋多少比例的局」。
//      作者據此決定寫到哪裡可以收工，不必把 66 個槽全填。
//
// 跑法：node dev/case-lint.mts [樣本數]

import { validateCase, slotCoverage, type CaseFile } from "../supabase/functions/_shared/case-schema.ts";
import { HUANGCUN } from "../supabase/functions/_shared/cases/huangcun.ts";

const CASES: CaseFile[] = [HUANGCUN];
const SAMPLES = Number(process.argv[2] ?? 20000);

const bar = (p: number, width = 24) => {
  const n = Math.round(p * width);
  return "█".repeat(n) + "░".repeat(width - n);
};
const pct = (p: number) => (p * 100).toFixed(1).padStart(5) + "%";

let failed = false;

for (const cf of CASES) {
  console.log(`\n${"═".repeat(66)}\n《${cf.title}》 ${cf.id} v${cf.version}\n${"═".repeat(66)}`);
  console.log(`  問句：${cf.question}    用神：${cf.useQin}`);
  console.log(`  進案時辰：${cf.entryHour == null ? "依玩家當下" : `${cf.entryHour} 時（固定）`}    真空局處置：${cf.voidPolicy}`);
  console.log(`  區域 ${cf.regions.length}　物件 ${cf.regions.reduce((s, r) => s + r.objects.length, 0)}　線索 ${cf.clues.length}　NPC ${cf.npcs.length}　同行 ${cf.companions.length}`);

  /* ① 結構 */
  const errs = validateCase(cf);
  console.log(`\n【結構驗證】`);
  if (errs.length) {
    failed = true;
    for (const e of errs) console.log(`  ❌ ${e}`);
  } else {
    console.log("  ✅ 通過");
  }

  /* ② 文本槽覆蓋 */
  const cov = slotCoverage(cf, SAMPLES);
  console.log(`\n【文本槽覆蓋】樣本 ${cov.samples} 局（固定種子，可重現）`);
  console.log(`  已填槽覆蓋 ${pct(cov.filledShare)} 的局    ${bar(cov.filledShare)}`);
  console.log(`  未填槽漏掉 ${pct(cov.missingShare)} 的局`);

  const missing = cov.needs.filter((n) => !n.filled);
  const filled = cov.needs.filter((n) => n.filled);
  const nameOf = (pos: number) => cf.regions.find((r) => r.pos === pos)?.name ?? `第${pos}區`;

  if (missing.length) {
    console.log(`\n  待填（依機率排序，寫到累積覆蓋滿意為止即可收工）：`);
    let acc = cov.filledShare;
    for (const n of missing.slice(0, 20)) {
      acc += n.prob;
      console.log(`    ${pct(n.prob)}  ${String(n.pos)} ${nameOf(n.pos).padEnd(6)} onKey.${n.access.padEnd(10)} → 補完累積 ${pct(acc)}`);
    }
    if (missing.length > 20) console.log(`    …另有 ${missing.length - 20} 個低機率組合，合計 ${pct(missing.slice(20).reduce((s, n) => s + n.prob, 0))}`);
  } else {
    console.log("\n  ✅ 所有實際會出現的組合都已填");
  }

  if (filled.length) {
    console.log(`\n  已填（${filled.length} 槽）：`);
    for (const n of filled) console.log(`    ${pct(n.prob)}  ${n.pos} ${nameOf(n.pos).padEnd(6)} onKey.${n.access}`);
  }

  /* ③ 角色槽：元神／忌神／世／應 */
  console.log(`\n【角色槽】各區擔任該角色的機率（未填者不報錯，但填了就是白撿的層次）`);
  const roleRows: [string, number[], (r: number) => boolean][] = [
    ["元神(助力) onYuan ", cov.roleShare.yuan, (p) => Boolean(cf.regions.find((r) => r.pos === p)?.onYuan)],
    ["忌神(阻力) onJi   ", cov.roleShare.ji, (p) => Boolean(cf.regions.find((r) => r.pos === p)?.onJi)],
    ["世(立足)   onStart", cov.roleShare.start, (p) => Boolean(cf.regions.find((r) => r.pos === p)?.onStart)],
    ["應(對手)   onRival", cov.roleShare.rival, (p) => Boolean(cf.regions.find((r) => r.pos === p)?.onRival)],
  ];
  for (const [label, share, has] of roleRows) {
    const cells = share.map((v, i) => `${i + 1}:${(v * 100).toFixed(0).padStart(2)}%${has(i + 1) ? "✓" : "·"}`).join("  ");
    const covered = share.reduce((s, v, i) => s + (has(i + 1) ? v : 0), 0);
    const total = share.reduce((s, v) => s + v, 0);
    console.log(`  ${label}  ${cells}   已填覆蓋 ${pct(total ? covered / total : 0)}`);
  }
}

console.log("");
if (failed) { console.log("❌ 有結構錯誤，修掉才能進下一步"); process.exit(1); }
console.log("✅ 結構全過");
