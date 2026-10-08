// dev/tianshi-test.mts — 此刻天時（流年、月建、九運）。跑法：node dev/tianshi-test.mts
const { tianshiLine, sanyuan, yearStar } = await import("../supabase/functions/_shared/tianshi.ts");
let p = 0, f = 0; const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };
const at = (iso: string) => tianshiLine(Date.parse(iso));
ok("2026 丙午、天河水", at("2026-10-05T12:00:00+08:00").includes("歲次丙午（馬年，納音天河水）"));
ok("立春前仍是乙巳", at("2026-02-01T12:00:00+08:00").includes("歲次乙巳"));
ok("寒露前月建丁酉", at("2026-10-05T12:00:00+08:00").includes("月建丁酉"));
ok("寒露後月建戊戌", at("2026-10-09T12:00:00+08:00").includes("月建戊戌"));
ok("九運 2024–2043 九紫離火", sanyuan(2026).yun === 9 && sanyuan(2026).from === 2024 && at("2026-10-05T12:00:00+08:00").includes("九紫離火當運"));
ok("八運 2004–2023", sanyuan(2023).yun === 8 && sanyuan(2004).from === 2004);
ok("2044 回到上元一運", sanyuan(2044).yun === 1 && sanyuan(2044).yuan === "上元");
ok("流年紫白：2024 三碧、2025 二黑、2026 一白、2027 九紫", yearStar(2024) === 3 && yearStar(2025) === 2 && yearStar(2026) === 1 && yearStar(2027) === 9);
console.log(`\n${p} 過 / ${f} 敗`); if (f) process.exit(1);
