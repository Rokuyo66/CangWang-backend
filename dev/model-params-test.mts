// dev/model-params-test.mts — 每一代「關掉思考」的參數寫對了沒（寫錯是 400，上線才知道）。
// 跑法：node dev/model-params-test.mts
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { noThinking, isNewTokenizer } = await import("../supabase/functions/_shared/model-params.ts");
let p = 0, f = 0; const t = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };
const type = (m: string) => (noThinking(m).body.thinking as { type?: string } | undefined)?.type ?? "（不帶）";

// 舊世代：不帶就不想，帶了 disabled 反而是多餘的欄位
t("sonnet-4-6 不帶", type("claude-sonnet-4-6") === "（不帶）");
t("haiku-4-5 不帶", type("claude-haiku-4-5-20251001") === "（不帶）");
// Sonnet 5／Opus 5：disabled
t("sonnet-5 disabled", type("claude-sonnet-5") === "disabled");
t("opus-5 disabled", type("claude-opus-5") === "disabled");
// Haiku 5.5：disabled（effort 預設 medium，≤ high 才收）
t("haiku-5-5 disabled", type("claude-haiku-5-5") === "disabled");
// Sonnet 5.5：disabled 是 400，要 between_tools，而且不能帶其他欄位
t("sonnet-5-5 between_tools", type("claude-sonnet-5-5") === "between_tools");
t("sonnet-5-5 不帶 effort", !("output_config" in noThinking("claude-sonnet-5-5").body));
t("sonnet-5-5 不加餘裕", noThinking("claude-sonnet-5-5").headroom === 0);
// Opus 5.5／Fable：關不掉，adaptive + low，另給餘裕
for (const m of ["claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
  t(`${m} adaptive`, type(m) === "adaptive");
  t(`${m} effort low`, (noThinking(m).body.output_config as { effort?: string } | undefined)?.effort === "low");
  t(`${m} 有餘裕`, noThinking(m).headroom > 0);
}
// tokenizer：Haiku 5.5 也是新的；4.5／4.6 不是
t("haiku-5-5 新 tokenizer", isNewTokenizer("claude-haiku-5-5"));
t("sonnet-5-5 新 tokenizer", isNewTokenizer("claude-sonnet-5-5"));
t("sonnet-4-6 舊 tokenizer", !isNewTokenizer("claude-sonnet-4-6"));
t("haiku-4-5 舊 tokenizer", !isNewTokenizer("claude-haiku-4-5-20251001"));
// 非 Claude（KIMI 走另一條路，這裡不該塞任何東西）
t("kimi 不帶", type("kimi-k2.6") === "（不帶）");

console.log(`${p} 過 / ${f} 敗`);
if (f) process.exit(1);
