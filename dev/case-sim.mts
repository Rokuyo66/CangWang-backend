// dev/case-sim.mts — 卦案投射的重玩價值驗證。
//
// 只回答一個問題：同一份固定素材（一張地圖、一個真相），配上一個真隨機卦，
// 能不能產出足夠多種「玩家感受得到差異」的佈局？
//
// 這一步零 AI、零 token、零內容、零前端。答「不能」，後面整套卦案系統都不用做。
//
// 跑法：node dev/case-sim.mts [次數]

import { buildChart, castCoins } from "../supabase/functions/_shared/core.ts";
import { projectCase, selfCheck, type CaseDef, type CaseState } from "../supabase/functions/_shared/case.ts";

/* ═══ 案件定義：荒村借宿（六區直接綁六爻爻位取象） ═══ */
const HUANGCUN: CaseDef = {
  id: "huangcun",
  title: "荒村借宿",
  question: "此行能否尋回失蹤的少女",
  useQin: "應", // 問無名分之陌生少女行蹤 → 取應爻（rules.ts 第 25 行）
  regions: [
    { pos: 1, name: "村口水井", image: "宅基·井·灶·地下" },
    { pos: 2, name: "主屋堂室", image: "宅·堂屋·廚房·內室" },
    { pos: 3, name: "西廂臥房", image: "門·床·臥房" },
    { pos: 4, name: "院牆廢廟", image: "戶·大門·外牆·近鄰" },
    { pos: 5, name: "山路村長家", image: "道路·行人·官府·人口" },
    { pos: 6, name: "後山古碑", image: "宗廟·屋頂·牆外·最高最遠" },
  ],
};

/* ═══ 工具 ═══ */
const N = Number(process.argv[2] ?? 20000);

function tally<T>(xs: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
function pct(n: number, d: number) { return ((n / d) * 100).toFixed(1) + "%"; }
function entropyEff(counts: number[], total: number): number {
  let h = 0;
  for (const c of counts) { const p = c / total; if (p > 0) h -= p * Math.log(p); }
  return Math.exp(h); // 有效佈局數：等機率下相當於幾種
}
function topN(m: Map<string, number>, n: number) {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
function randDate() {
  return { y: 2026, m: 1 + Math.floor(Math.random() * 12), d: 1 + Math.floor(Math.random() * 28), hour: Math.floor(Math.random() * 24) };
}

function runBatch(n: number, fixedDate: boolean, def: CaseDef = HUANGCUN): CaseState[] {
  const fixed = { y: 2026, m: 8, d: 18, hour: 19 };
  const out: CaseState[] = [];
  for (let i = 0; i < n; i++) {
    const { lines } = castCoins();
    const dt = fixedDate ? fixed : randDate();
    out.push(projectCase(buildChart(lines, dt.y, dt.m, dt.d, dt.hour), def));
  }
  return out;
}

/* ═══ 報告 ═══ */
function report(label: string, states: CaseState[]) {
  const n = states.length;
  console.log(`\n${"═".repeat(62)}\n${label}（n=${n}）\n${"═".repeat(62)}`);

  for (const level of ["core", "feel", "full"] as const) {
    const m = tally(states.map((s) => s.sig[level]));
    const eff = entropyEff([...m.values()], n);
    const maxShare = Math.max(...m.values()) / n;
    const label2 = { core: "core（線索在哪＋好不好拿）", feel: "feel（玩家感受得到的佈局）", full: "full（含六神方位細節）" }[level];
    console.log(`\n【${label2}】`);
    console.log(`  相異種類：${m.size}    有效佈局數：${eff.toFixed(1)}    最大單一佔比：${pct(Math.max(...m.values()), n)}`);
    if (level === "feel") {
      console.log("  前 8 名：");
      for (const [k, v] of topN(m, 8)) console.log(`    ${pct(v, n).padStart(6)}  ${k}`);
    }
    if (level === "core") {
      console.log("  全部：");
      for (const [k, v] of topN(m, 99)) console.log(`    ${pct(v, n).padStart(6)}  ${k}`);
    }
    void maxShare;
  }

  // 各維度分佈
  const dims: [string, (s: CaseState) => string][] = [
    ["關鍵線索區 keyPos", (s) => String(s.key.pos ?? "不上卦")],
    ["取得代價 access", (s) => s.access],
    ["玩家立足區 startPos(世)", (s) => String(s.startPos)],
    ["對手區 rivalPos(應)", (s) => String(s.rivalPos)],
    ["節奏 tempo", (s) => s.tempo],
    ["用神伏藏", (s) => (s.key.hidden ? "伏" : "現")],
    ["用神月令旺衰", (s) => s.key.wang ?? "-"],
    ["用神力量 grade", (s) => s.key.grade],
    ["世用生剋", (s) => s.shiYong ?? "-"],
    ["忌神(阻力)態勢", (s) => (s.support.jiStrong ? "旺動" : s.support.jiActive ? "發動" : "靜")],
    ["元神(助力)態勢", (s) => (s.support.yuanActive ? "發動" : "靜")],
    ["主軸方位 palaceDir", (s) => s.palaceDir],
  ];
  console.log("\n【各維度分佈】");
  for (const [name, f] of dims) {
    const m = tally(states.map(f));
    const line = [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${pct(v, n)}`).join("  ");
    console.log(`  ${name.padEnd(24)} ${line}`);
  }

  // 重玩價值：連續兩次／三次是否感覺不同
  const feels = states.map((s) => s.sig.feel);
  const cores = states.map((s) => s.sig.core);
  let diff2 = 0, distinct3feel = 0, distinct3core = 0;
  for (let i = 0; i + 1 < n; i += 2) if (feels[i] !== feels[i + 1]) diff2++;
  for (let i = 0; i + 2 < n; i += 3) {
    distinct3feel += new Set([feels[i], feels[i + 1], feels[i + 2]]).size;
    distinct3core += new Set([cores[i], cores[i + 1], cores[i + 2]]).size;
  }
  console.log("\n【重玩價值】");
  console.log(`  連兩局 feel 佈局不同的機率：${pct(diff2, Math.floor(n / 2))}`);
  console.log(`  三局平均看到幾種不同 feel：${(distinct3feel / Math.floor(n / 3)).toFixed(2)} / 3`);
  console.log(`  三局平均看到幾種不同 core：${(distinct3core / Math.floor(n / 3)).toFixed(2)} / 3  ← 這才是內容真正要撐的差異`);

  // 退化風險：玩家一開局就站在關鍵線索上 → 案子可能秒破，需要特別設計
  const onKey = states.filter((s) => s.startPos === s.key.pos).length;
  const rivalKey = states.filter((s) => s.rivalPos === s.key.pos).length;
  console.log("\n【退化風險】");
  console.log(`  世持用神（立足區＝關鍵線索區，開局即站在線索上）：${pct(onKey, n)}`);
  console.log(`  應持用神（線索在對手手上）：${pct(rivalKey, n)}`);
}

function dump(s: CaseState) {
  const k = s.key, sp = s.support;
  console.log(`\n  ── ${s.benName}${s.turnTo ? ` 之 ${s.turnTo}` : ""}（${s.palace}宮${s.guaType}）`);
  console.log(`     主軸方位 ${s.palaceDir}${s.turnDir ? ` → 翻面 ${s.turnDir}` : ""}   節奏 ${s.tempo}   ${s.omens.join("、") || "無特殊格局"}`);
  console.log(`     用神${s.useQin} 落 ${k.pos ?? "不上卦"} 區${k.hidden ? `（伏於 ${k.flyPos} 區飛神下，${k.chuFu}）` : ""}`);
  console.log(`     旺衰 ${k.wang}／${k.grade}   ${[k.kong, k.mu, k.po, k.anDong ? "暗動" : null].filter(Boolean).join("·") || "無空破墓"}   日辰 ${k.dayActs.join("·") || "不作用"}`);
  console.log(`     代價 ${s.access}   世用 ${s.shiYong}   立足 ${s.startPos} 區   對手 ${s.rivalPos} 區`);
  console.log(`     元神(助) ${sp.yuanPos.join("、") || "無"}${sp.yuanActive ? " 發動" : ""}   忌神(阻) ${sp.jiPos.join("、") || "無"}${sp.jiStrong ? " 旺動" : sp.jiActive ? " 發動" : ""}${sp.tongGuan ? "   →貪生忘剋通關" : ""}`);
  for (const r of s.regions.slice().reverse()) {
    const mark = r.roles.length ? `[${r.roles.join("")}]` : "";
    const mv = r.moving ? `動→${r.flux.join("·") || "平變"}` : r.anDong ? "暗動" : "";
    console.log(`     ${r.pos} ${r.name.padEnd(6)} ${r.qin}${r.zhi}(${r.wx}) ${r.beast} ${r.dir.padEnd(2)} ${mark}${mv} ${r.tags.length ? "【" + r.tags.join("·") + "】" : ""}`);
  }
}

/* ═══ main ═══ */
const errs = selfCheck();
console.log(errs.length ? `❌ 自檢失敗：\n  ${errs.join("\n  ")}` : "✅ 卦理常數自檢通過（八卦上卦對照 64 卦、沖合墓、生剋、旬空、八方位）");
if (errs.length) process.exit(1);

// 裁決：用神依所問之事取，不為遊戲效果攀親帶故。荒村借宿問的是無名分之
// 陌生少女行蹤 → 取應爻。單一案件內世應組合固定不是缺點，變化由旺衰生剋
// 與元忌神承擔——A 就是在驗這句話。C 保留六親路徑，證明飛伏機制未消失。
const HUANGCUN_ZISUN: CaseDef = { ...HUANGCUN, id: "huangcun_zisun", useQin: "子孫" };

report("A. 用神取應（問陌生少女行蹤·正統取法）＋ 隨機進案時間", runBatch(N, false));
report("B. 用神取應 ＋ 固定進案時間（2026-08-18 戌時，隔離時間變因）", runBatch(N, true));
report("C. 用神取子孫（六親路徑，飛伏仍在）＋ 隨機進案時間", runBatch(N, false, HUANGCUN_ZISUN));

/* ═══ 用神類型 → 案件手感對照 ═══
   同一張地圖，換一個用神就換一種佈局分佈。
   這代表「案件類型」可以直接由「所問之事的用神」決定，不必另造難度系統。 */
console.log(`\n${"═".repeat(62)}\n用神類型 → 案件手感（同地圖、隨機時間、n=${N}）\n${"═".repeat(62)}`);
console.log(`  ${"用神".padEnd(6)}${"core種數".padEnd(9)}${"有效數".padEnd(8)}${"伏藏率".padEnd(8)}${"世持用神".padEnd(9)}關鍵線索區分佈 1→6`);
for (const qin of ["父母", "兄弟", "官鬼", "妻財", "子孫", "應"]) {
  const st = runBatch(N, false, { ...HUANGCUN, id: `q_${qin}`, useQin: qin });
  const core = tally(st.map((s) => s.sig.core));
  const hid = pct(st.filter((s) => s.key.hidden).length, N);
  const onKey = pct(st.filter((s) => s.startPos === s.key.pos).length, N);
  const kp = tally(st.map((s) => s.key.pos));
  const dist = [1, 2, 3, 4, 5, 6].map((p) => ((kp.get(p) ?? 0) / N * 100).toFixed(0).padStart(3)).join(" ");
  console.log(`  ${qin.padEnd(6)}${String(core.size).padEnd(9)}${entropyEff([...core.values()], N).toFixed(1).padEnd(8)}${hid.padEnd(8)}${onKey.padEnd(9)}${dist}`);
}

console.log(`\n${"═".repeat(62)}\n樣本盤面（供六六核對卦理是否成立）\n${"═".repeat(62)}`);
for (const s of runBatch(3, false)) dump(s);
