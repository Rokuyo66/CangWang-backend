// dev/local-llm-test.mts — 本地 Ollama 備援（_shared/local-llm.ts）：帶對驗證頭、關思考、掛了進冷卻。
// 跑法：node dev/local-llm-test.mts
const env: Record<string, string> = {
  LOCAL_LLM_URL: "https://llm.example.com/", LOCAL_CF_ID: "id1", LOCAL_CF_SECRET: "sec1", LOCAL_DOWN_COOLDOWN_MS: "60000",
};
(globalThis as Record<string, unknown>).Deno = { env: { get: (k: string) => env[k] } };
let p = 0, f = 0; const t = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };

let seen: { url: string; headers: Record<string, string>; body: Record<string, any> } | null = null;
let reply: () => Response = () => new Response(JSON.stringify({ message: { content: "<think>想</think>「說吧。」" }, prompt_eval_count: 10, eval_count: 5 }));
globalThis.fetch = (async (url: string, init: RequestInit) => {
  seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  return reply();
}) as typeof fetch;

const { callLocal, localEnabled, LOCAL_MODEL } = await import("../supabase/functions/_shared/local-llm.ts");
const call = () => callLocal({ system: "S", messages: [{ role: "user", content: "嗨" }], maxTokens: 100, timeoutMs: 1000 });

t("有網址就啟用", localEnabled());
const r = await call();
t("打原生 /api/chat、去掉結尾斜線", seen!.url === "https://llm.example.com/api/chat");
t("帶 Cloudflare Access 兩個頭", seen!.headers["CF-Access-Client-Id"] === "id1" && seen!.headers["CF-Access-Client-Secret"] === "sec1");
t("沒設 token 就不帶 authorization", !("authorization" in seen!.headers));
t("關思考", seen!.body.think === false);
t("system 排第一", seen!.body.messages[0].role === "system" && seen!.body.messages[1].content === "嗨");
t("num_predict／num_ctx", seen!.body.options.num_predict === 100 && seen!.body.options.num_ctx === 8192);
t("剝掉 <think>", r.text === "「說吧。」");
t("model 記成 local/ 前綴", r.model === `local/${LOCAL_MODEL}`);
t("token 數", r.tokensIn === 10 && r.tokensOut === 5);

reply = () => new Response("tunnel up, origin down", { status: 530 });
let threw = false; try { await call(); } catch { threw = true; }
t("家裡那台不在 → 丟錯", threw);
t("丟錯後進冷卻", !localEnabled());
seen = null; threw = false; try { await call(); } catch { threw = true; }
t("冷卻中不再連線", threw && seen === null);

console.log(`\n${p} 過 / ${f} 敗`);
if (f) process.exit(1);
