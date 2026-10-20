// _shared/claude.ts — 管家呼叫 Claude 的兩種方式：一般問答（Haiku）、帶網路搜尋（Sonnet）
//
// 照這個 repo 的慣例直接打 HTTP（產品端也是），不另外裝 SDK。
import { noThinking } from "./mailbot.ts";

const API = "https://api.anthropic.com/v1/messages";
const headers = (beta?: string) => ({
  "content-type": "application/json",
  "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  "anthropic-version": "2023-06-01",
  ...(beta ? { "anthropic-beta": beta } : {}),
});

export class ClaudeAuthError extends Error {}

// deno-lint-ignore no-explicit-any
const textOf = (data: any) => (data?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");

/** 一次問答，回純文字。401／403 丟 ClaudeAuthError，讓呼叫端推「金鑰失效」的警告。 */
export async function ask(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
  const model = opts.model ?? Deno.env.get("MAILBOT_MODEL") ?? "claude-haiku-5-5";
  const nt = noThinking(model);
  const res = await fetch(API, {
    method: "POST", headers: headers(),
    body: JSON.stringify({
      model, max_tokens: (opts.maxTokens ?? 1500) + nt.headroom, ...nt.body,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (res.status === 401 || res.status === 403) throw new ClaudeAuthError(`anthropic ${res.status}`);
  if (!res.ok) throw new Error(`anthropic ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  console.log("mailbot usage", model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
  return textOf(data);
}

/** 帶網路搜尋的一次問答，只搜 allowedDomains。
 *  web_search_20260209 只有 Sonnet 5.5／Opus 等支援（Haiku 不行），所以預設 Sonnet 5.5。
 *  伺服器端工具跑太久會回 pause_turn：把回覆接回去再送，最多三輪。
 *  fallbacks:"default"：模型因安全分類拒答時，由伺服器換模型重試（Sonnet 5.5 在 Claude API 上的建議設定）。 */
export async function askWithSearch(system: string, user: string, allowedDomains: string[], maxUses = 6): Promise<string> {
  const model = Deno.env.get("MAILBOT_NEWS_MODEL") ?? "claude-sonnet-5-5";
  // deno-lint-ignore no-explicit-any
  const messages: any[] = [{ role: "user", content: user }];
  let text = "";
  for (let round = 0; round < 3; round++) {
    const res = await fetch(API, {
      method: "POST", headers: headers("server-side-fallback-2026-07-01"),
      body: JSON.stringify({
        model, max_tokens: 8000,
        output_config: { effort: "low" },
        fallbacks: "default",
        system, messages,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses, allowed_domains: allowedDomains }],
      }),
    });
    if (res.status === 401 || res.status === 403) throw new ClaudeAuthError(`anthropic ${res.status}`);
    if (!res.ok) throw new Error(`anthropic ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    console.log("mailbot news usage", data.model, data.usage?.input_tokens ?? 0, data.usage?.output_tokens ?? 0);
    if (data.stop_reason === "refusal") throw new Error("模型拒答（refusal）");
    text = textOf(data);
    if (data.stop_reason !== "pause_turn") return text;
    messages.push({ role: "assistant", content: data.content });
  }
  return text;
}
