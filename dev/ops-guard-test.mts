// dev/ops-guard-test.mts — 免認證端點限流（ip-limit.ts）與每日 AI 成本告警（cost-alert.ts）
// 跑法：node dev/ops-guard-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

const { clientIp, ipLimited, _resetIpLimit } = await import("../supabase/functions/_shared/ip-limit.ts");
const { costAlertText } = await import("../supabase/functions/_shared/cost-alert.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
};
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

console.log("\n免認證端點限流\n");
t("取第一個 x-forwarded-for", () => {
  const r = new Request("https://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
  ok(clientIp(r) === "1.2.3.4", String(clientIp(r)));
});
t("沒有任何 IP 標頭就不限流", () => {
  const r = new Request("https://x");
  ok(clientIp(r) === null, "應為 null");
  for (let i = 0; i < 500; i++) ok(!ipLimited(null, 0, 5), "null 不該被擋");
});
t("同一分鐘第 N+1 次才擋", () => {
  _resetIpLimit();
  for (let i = 0; i < 5; i++) ok(!ipLimited("a", 1000, 5), `第 ${i + 1} 次不該擋`);
  ok(ipLimited("a", 1001, 5), "第 6 次該擋");
});
t("過了一分鐘重數；不同 IP 各數各的", () => {
  _resetIpLimit();
  for (let i = 0; i < 6; i++) ipLimited("a", 0, 5);
  ok(!ipLimited("b", 10, 5), "b 不受 a 影響");
  ok(!ipLimited("a", 60_000, 5), "下一分鐘 a 應重數");
});

console.log("\n每日 AI 成本告警\n");
const base = { calls: 300, calls_unpriced: 0, twd: 20, active_users: 12,
  by_mode: { chat: { calls: 250, twd: 2.5 }, cast: { calls: 30, twd: 21 }, followup: { calls: 20, twd: 12.4 } } };
t("平常的一天不推", () => ok(costAlertText(base, 100) === null, "不該推"));
t("超過門檻要推，並列出花最多的", () => {
  const s = costAlertText({ ...base, twd: 180 }, 100);
  ok(s && s.includes("180") && s.includes("cast"), String(s));
  ok(s!.indexOf("cast") < s!.indexOf("followup"), "應照金額排序");
});
t("有未定價的呼叫，金額沒超標也要推", () => {
  const s = costAlertText({ ...base, calls_unpriced: 7 }, 100);
  ok(s && s.includes("7 次呼叫沒有單價"), String(s));
});
t("模式名稱會轉義（TG HTML）", () => {
  const s = costAlertText({ ...base, twd: 999, by_mode: { "<x>": { calls: 1, twd: 999 } } }, 100);
  ok(s && s.includes("&lt;x&gt;") && !s.includes("<x>"), String(s));
});

console.log(`\n${fail ? "❌" : "✅"} ${pass} 通過，${fail} 失敗\n`);
if (fail) process.exit(1);
