// dev/reflect-test.mts — 回評後反芻（_shared/reflect.ts）。跑法：node dev/reflect-test.mts
//
// 驗的是這一層答應過的事：
//   目錄外的判法、拼錯的標籤進不了統計；
//   樣本少時不分級（3 中 0 不等於這條判法不準）；
//   判法輕重只寫偏離常規的那幾條，而且明說「不改規則、照推」；
//   改評（準→不準）時舊判定整批換掉，不跟新判定疊加；
//   人手鎖定的分級，重算不覆蓋；
//   回報「未發生」的卦不反省。

import { fakeDb } from "./fake-db.mts";
import {
  parseReflection, wilson, tierOf, computeTiers, priorityBlock, userNotesBlock,
  reflectCast, recomputePriority, loadPriorityBlock, loadUserNotes, __resetPriorityCache,
  MIN_RULE_N, MIN_BASELINE_N, RULE_CATALOG,
} from "../supabase/functions/_shared/reflect.ts";

let ok = 0, bad = 0;
const t = (n: string, c: boolean) => { c ? ok++ : (bad++, console.log("✗", n)); };

/* ---------- 解析 ---------- */
{
  const r = parseReflection(`<rules>xunkong:primary:failed; month_strength:secondary:held;bogus:primary:held;xunkong:primary:held;day_effect:main:held;huitou:primary:wrong</rules>
<attr>timing</attr>
<why>靠旬空斷延遲，結果提前應。</why>
<cf>若取日辰沖空為實，就對得上。</cf>
<lesson>他問工作時真正在意的是主管的態度。</lesson>`);
  t("目錄內的判法留下", r.rules.map((x) => x.key).join() === "xunkong,month_strength");
  t("同一 key 只取第一次", r.rules.filter((x) => x.key === "xunkong").length === 1 && r.rules[0].outcome === "failed");
  t("role 拼錯的丟掉", !r.rules.some((x) => x.key === "day_effect"));
  t("outcome 拼錯的丟掉", !r.rules.some((x) => x.key === "huitou"));
  t("歸因", r.attr === "timing");
  t("反事實", r.cf?.startsWith("若取日辰") === true);
  t("關於這個人", r.lesson === "他問工作時真正在意的是主管的態度。");

  const n = parseReflection("<rules>none</rules><attr>不知道</attr><why>x</why><cf>null</cf><lesson>無</lesson>");
  t("none → 沒有判法", n.rules.length === 0);
  t("認不得的歸因落 unclear", n.attr === "unclear");
  t("null／無 → null", n.cf === null && n.lesson === null);
  t("全形冒號與分號也認", parseReflection("<rules>yuepo：primary：held；rumu:secondary:unclear</rules>").rules.length === 2);
  t("什麼標籤都沒有也不炸", parseReflection("模型亂講").attr === "unclear");
}

/* ---------- 分級 ---------- */
{
  const w = wilson(0, 3);
  t("3 中 0 的區間很寬", w.hi > 0.3);
  t("樣本少一律常規", tierOf({ key: "x", held: 0, failed: MIN_RULE_N - 1 }, 0.6) === 0);
  t("樣本夠且明顯偏低 → 降級", tierOf({ key: "x", held: 3, failed: 17 }, 0.65) === -1);
  t("樣本夠且明顯偏高 → 優先", tierOf({ key: "x", held: 19, failed: 1 }, 0.6) === 1);
  t("略低於基準但不顯著 → 常規", tierOf({ key: "x", held: 6, failed: 4 }, 0.65) === 0);

  t("全站樣本不足 → 整套不啟動", computeTiers([{ key: "a", held: 2, failed: 20 }]) === null);
  const res = computeTiers([
    { key: "xunkong", held: 3, failed: 17 },
    { key: "month_strength", held: 40, failed: 10 },
    { key: "day_effect", held: 30, failed: 12 },
  ])!;
  t("基準是全站加權命中率", Math.abs(res.baseline - 73 / 112) < 1e-9);
  t("偏低者降級", res.tiers.xunkong === -1);
  t("其餘照統計", res.tiers.day_effect === 0);
  t("MIN_BASELINE_N 合理", MIN_BASELINE_N >= MIN_RULE_N);
}

/* ---------- 提示文字 ---------- */
{
  t("沒有偏離常規 → 空字串", priorityBlock([{ rule_key: "xunkong", tier: 0, held: 1, failed: 1 }]) === "");
  const b = priorityBlock([
    { rule_key: "xunkong", tier: -1, held: 3, failed: 17 },
    { rule_key: "month_strength", tier: 1, held: 40, failed: 10 },
    { rule_key: "retired_key", tier: -1, held: 0, failed: 30 },
  ]);
  t("明說不改規則", b.includes("規則本文照舊全部適用"));
  t("降級的寫上中文名與次數", b.includes("旬空主虛、主延遲（印證 20 次，撐住 3 次）"));
  t("優先的也寫上", b.includes("月令定旺衰"));
  t("目錄外的 key 不寫", !b.includes("retired_key"));
  t("沒有提醒 → 空字串", userNotesBlock([]) === "");
  t("提醒只用來理解問事", userNotesBlock(["a"]).includes("不得因此改變本卦的卦理判斷"));
  t("目錄 key 不重複", new Set(RULE_CATALOG.map((r) => r.key)).size === RULE_CATALOG.length);
}

/* ---------- 反省一卦（資料庫） ---------- */
const seed = () => ({
  casts: [{ id: "c1", user_id: "u1", question: "這份工作月底前會有消息嗎", chart: { benName: "乾為天" },
    reading: "月底前恐怕還沒有消息。", deep_reading: null, due_date: "2026-10-31", created_at: "2026-10-01T00:00:00Z" }],
  feedback: [{ cast_id: "c1", user_id: "u1", verdict: 3, note: "隔週就錄取了", answered_at: "2026-10-09T00:00:00Z" }],
  followups: [{ cast_id: "c1", question: "其實我比較在意主管", answer: "我先前以為你問錄不錄取。\n\n你在意的是主管的人品，還是主管對你的評價？",
    ask: "你在意的是主管的人品，還是主管對你的評價？", revision: null, created_at: "2026-10-02T00:00:00Z" }],
});
const chartText = (c: unknown, q: string) => `盤面:${(c as { benName: string }).benName}／${q}`;

{
  const db = fakeDb(seed());
  let seen = "";
  const ref = await reflectCast(db as never, "c1", {
    chartText,
    ask: async (input) => { seen = input; return { text: "<rules>xunkong:primary:failed;month_strength:secondary:held</rules><attr>timing</attr><why>w</why><cf>c</cf><lesson>他在意的是主管。</lesson>" }; },
  });
  t("反省有結果", ref?.attr === "timing");
  t("輸入有盤面", seen.includes("盤面:乾為天／這份工作月底前會有消息嗎"));
  t("輸入有回報與心得", seen.includes("不準") && seen.includes("隔週就錄取了"));
  t("輸入有追問與反問", seen.includes("其實我比較在意主管") && seen.includes("（解卦人反問）"));
  const s = db._store as Record<string, Record<string, unknown>[]>;
  t("存了反省", s.cast_reflections.length === 1 && s.cast_reflections[0].attribution === "timing");
  t("存了判法列", s.reflection_rules.length === 2);
  t("存了個人提醒", s.user_reading_notes.length === 1 && s.user_reading_notes[0].note === "他在意的是主管。");
  t("判法統計寫進 rule_priority（樣本不足 → 常規）", s.rule_priority.every((r) => r.tier === 0));

  // 改評：不準 → 準。舊判定與舊提醒要整批換掉
  s.feedback[0].verdict = 1;
  await reflectCast(db as never, "c1", {
    chartText,
    ask: async () => ({ text: "<rules>xunkong:primary:held</rules><attr>hit</attr><why>w</why><cf>null</cf><lesson>null</lesson>" }),
  });
  t("改評後只剩新判定", s.reflection_rules.length === 1 && s.reflection_rules[0].outcome === "held" && s.reflection_rules[0].verdict === 1);
  t("改評後反省只有一份", s.cast_reflections.length === 1 && s.cast_reflections[0].attribution === "hit");
  t("新反省沒有提醒 → 舊提醒拿掉", s.user_reading_notes.length === 0);
}
{
  const sd = seed(); sd.feedback[0].verdict = 0;
  const db = fakeDb(sd);
  let called = false;
  const ref = await reflectCast(db as never, "c1", { chartText, ask: async () => { called = true; return { text: "" }; } });
  t("未發生不反省、不花模型", ref === null && !called);
}
{
  const db = fakeDb(seed());
  const ref = await reflectCast(db as never, "c1", { chartText, ask: async () => { throw new Error("模型掛了"); } });
  t("模型失敗不丟出", ref === null);
}

/* ---------- 重算與鎖定 ---------- */
{
  const rules: Record<string, unknown>[] = [];
  let i = 0;
  const add = (key: string, outcome: string, n: number) => { for (let k = 0; k < n; k++) rules.push({ cast_id: `x${i++}`, rule_key: key, role: "primary", outcome, verdict: 1 }); };
  add("xunkong", "held", 3); add("xunkong", "failed", 17);
  add("month_strength", "held", 40); add("month_strength", "failed", 10);
  add("yuepo", "held", 2); add("yuepo", "failed", 18);
  add("rumu", "misapplied", 50);   // 盤面讀錯的不算到判法頭上
  const db = fakeDb({ reflection_rules: rules, rule_priority: [{ rule_key: "yuepo", tier: 1, held: 0, failed: 0, locked: true }] });
  await recomputePriority(db as never);
  const s = db._store as Record<string, Record<string, unknown>[]>;
  const tierOfKey = (k: string) => s.rule_priority.find((r) => r.rule_key === k)?.tier;
  t("偏低者被降級", tierOfKey("xunkong") === -1);
  t("鎖定的不被覆蓋", tierOfKey("yuepo") === 1);
  t("misapplied 不計入", (s.rule_priority.find((r) => r.rule_key === "rumu")?.failed ?? 0) === 0);

  __resetPriorityCache();
  const block = await loadPriorityBlock(db as never);
  t("提示讀得到降級", block.includes("旬空"));
  t("提示讀得到鎖定的優先", block.includes("月破"));
}
{
  const db = fakeDb({ user_reading_notes: [
    { user_id: "u1", note: "舊", created_at: "2026-01-01" },
    ...Array.from({ length: 6 }, (_, k) => ({ user_id: "u1", note: `新${k}`, created_at: `2026-09-0${k + 1}` })),
    { user_id: "u2", note: "別人的", created_at: "2026-09-30" },
  ] });
  const b = await loadUserNotes(db as never, "u1");
  t("只帶最近五句", (b.match(/・/g) ?? []).length === 5 && !b.includes("舊"));
  t("不帶別人的", !b.includes("別人的"));
}

console.log(`${ok} 過 / ${bad} 敗`);
if (bad) process.exit(1);
