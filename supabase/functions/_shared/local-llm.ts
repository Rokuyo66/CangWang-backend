// _shared/local-llm.ts — 六六家裡那台（WSL 的 Ollama，RTX A4000 16GB）當最後一道備援
//
// 位置：閒聊 Haiku → Groq → NVIDIA → 【本地】 → 罐頭；解卦 主模型 → 備援 → 【本地】 → 丟錯。
// 是底線不是主力：電腦會關、ComfyUI 跑圖時會搶 VRAM，掛了就照舊往下掉。
//
// 【沒設 LOCAL_LLM_URL＝整層不存在】不連線、不等、不記錯，線上行為跟沒加這支一模一樣。
//
// 【驗證】Ollama 本身沒有密碼，直接開到外網等於把 GPU 送人用。兩種擋法擇一（或都上）：
//   ① Cloudflare Tunnel ＋ Access Service Token：LOCAL_CF_ID／LOCAL_CF_SECRET
//      → 帶 CF-Access-Client-Id／CF-Access-Client-Secret，沒帶的請求在 Cloudflare 就被擋，到不了家裡
//   ② 自架反向代理（Caddy 等）驗 Bearer：LOCAL_LLM_TOKEN
//
// 【走 Ollama 原生 /api/chat，不走 /v1】原生端點才收得到這三個：
//   think:false       Qwen 3.5 預設先想再答，6 秒內出不了字
//   options.num_ctx   Ollama 預設 context 很短，解卦的規則就九千多 token，不調會被靜靜截掉開頭
//   keep_alive        模型留在 VRAM，免得每次冷啟動載入就把逾時吃光

const URL_ = (Deno.env.get("LOCAL_LLM_URL") ?? "").replace(/\/+$/, "");
export const LOCAL_MODEL = Deno.env.get("LOCAL_LLM_MODEL") ?? "qwen3.5:9b";
const KEEP_ALIVE = Deno.env.get("LOCAL_KEEP_ALIVE") ?? "30m";
// 連續失敗後冷卻：電腦關機時每一則都去敲一次、各等一次逾時，等於每則白白多拖幾秒。
// 只在同一個 isolate 內有效（Edge Function 會回收），夠用——目的只是別連撞。
const DOWN_COOLDOWN_MS = Number(Deno.env.get("LOCAL_DOWN_COOLDOWN_MS") ?? "120000");
let downUntil = 0;

export const localEnabled = () => !!URL_ && Date.now() >= downUntil;

export async function callLocal(p: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  timeoutMs: number;
  numCtx?: number;
  temperature?: number;
}): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null; model: string }> {
  if (!URL_) throw new Error("local off");
  if (Date.now() < downUntil) throw new Error("local cooling down");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cfId = Deno.env.get("LOCAL_CF_ID"), cfSecret = Deno.env.get("LOCAL_CF_SECRET");
  if (cfId && cfSecret) { headers["CF-Access-Client-Id"] = cfId; headers["CF-Access-Client-Secret"] = cfSecret; }
  const token = Deno.env.get("LOCAL_LLM_TOKEN");
  if (token) headers["authorization"] = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), p.timeoutMs);
  try {
    const res = await fetch(`${URL_}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LOCAL_MODEL,
        messages: [{ role: "system", content: p.system }, ...p.messages],
        stream: false,
        think: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: p.maxTokens, num_ctx: p.numCtx ?? 8192, temperature: p.temperature ?? 0.9 },
      }),
      signal: ctrl.signal,
    });
    // 530／502＝Tunnel 在、家裡那台不在（關機或 Ollama 沒開）；403＝驗證沒過。都算「不在」，進冷卻。
    if (!res.ok) throw new Error(`local ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = String(data.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) throw new Error("local empty");
    return { text, tokensIn: data.prompt_eval_count ?? null, tokensOut: data.eval_count ?? null, model: `local/${LOCAL_MODEL}` };
  } catch (e) {
    downUntil = Date.now() + DOWN_COOLDOWN_MS;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
