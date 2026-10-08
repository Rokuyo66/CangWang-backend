// dev/yingqi-test.mts — 應期日曆：干支換西曆查得對不對（模型照抄這張表，表錯了應期就全錯）。
// 跑法：node dev/yingqi-test.mts
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { yingqiText, nextZhiDays, nextMonths, nextYears } = await import("../supabase/functions/_shared/yingqi.ts");
const { buildChart } = await import("../supabase/functions/_shared/core.ts");
const { chartTextFull } = await import("../supabase/functions/_shared/dongyao.ts");
let p = 0, f = 0; const t = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };
const s = (x: { y: number; m: number; d: number }) => `${x.y}/${x.m}/${x.d}`;

// 2026/10/8 乙卯（model-ab 第 1 題）：三個模型都算錯的那幾個日子
const zd = nextZhiDays({ y: 2026, m: 10, d: 8 });
t("今天卯日算第一次", s(zd["卯"][0]) === "2026/10/8");
t("下一個亥日 10/16（不是 10/19）", s(zd["亥"][0]) === "2026/10/16");
t("下一個辰日 10/9、再下一個 10/21（不是 10/24）", s(zd["辰"][0]) === "2026/10/9" && s(zd["辰"][1]) === "2026/10/21");
t("每支都湊滿兩次", Object.values(zd).every((v) => v.length === 2));
t("兩次相隔 12 天", Object.values(zd).every((v) => (Date.UTC(v[1].y, v[1].m - 1, v[1].d) - Date.UTC(v[0].y, v[0].m - 1, v[0].d)) / 864e5 === 12));

// 月建以節交接：寒露 10/8 入戌月、立冬 11/7 入亥月（不是「10 月下旬」）
const ms = nextMonths({ y: 2026, m: 10, d: 8 });
t("本月戌月戊戌", ms[0].gz === "戊戌" && s(ms[0].start) === "2026/10/8");
t("亥月 11/7 起", ms[1].gz === "己亥" && s(ms[1].start) === "2026/11/7" && s(ms[0].end) === "2026/11/6");
t("跨年接得上（子月→丑月）", s(ms[3].start) === "2027/1/5" && ms[3].gz === "辛丑");
// 節前一天還在上個月
const before = nextMonths({ y: 2026, m: 10, d: 7 });
t("10/7 還在酉月", before[0].gz[1] === "酉");

// 流年以立春交接
const ys = nextYears({ y: 2026, m: 10, d: 8 });
t("今年丙午、明年丁未", ys[0].gz === "丙午" && ys[1].gz === "丁未" && s(ys[1].start) === "2027/2/4");
const jan = nextYears({ y: 2027, m: 1, d: 20 });
t("立春前仍是前一年", jan[0].gz === "丙午");

// 文字：旬空出旬、已過的日子不列
const txt = yingqiText({ y: 2026, m: 10, d: 8 });
t("旬空子丑、本旬至 10/16", txt.includes("旬空：子丑（本旬至 10/16 止，10/17 起出旬）"));
t("亥那一行", txt.includes("亥：10/16（五）癸亥、10/28（三）乙亥"));
const later = yingqiText({ y: 2026, m: 10, d: 8 }, { y: 2026, m: 10, d: 20 });
t("追問晚於占期：從今天起算", later.includes("起算日：2026/10/20（二）丁卯日") && later.includes("已過的日子不列"));
t("追問晚於占期：過去的亥日不列", !later.includes("10/16"));
t("過了旬就不寫旬空", !later.includes("旬空："));
t("今天早於占期（手動排未來盤）照占期起算", yingqiText({ y: 2026, m: 10, d: 8 }, { y: 2026, m: 10, d: 1 }).includes("起算日：2026/10/8"));

// 接進盤面：解卦有、日運沒有
const chart = buildChart([7, 8, 9, 7, 8, 7], 2026, 10, 8, 10);
t("盤面帶日曆", chartTextFull(chart, "測").includes("【應期日曆"));
t("日運不帶", !chartTextFull(chart, "測", { calendar: false }).includes("【應期日曆"));
t("長度有節制（< 700 字）", txt.length < 700);

console.log(`${p} 過 / ${f} 敗`);
if (f) process.exit(1);
