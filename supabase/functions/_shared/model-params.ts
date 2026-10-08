// _shared/model-params.ts — 單發呼叫（解卦、日運、月誌、擬題、起居注）的「不要想」參數。
//
// 這幾支要的是照規則寫出一段字，不需要外顯推理；思考 token 又算進 max_tokens，
// 會把只有幾百字的正文額度吃掉（Haiku 5.5 不帶參數時預設就會想）。
// 但每一代「關掉思考」的寫法不同，寫錯是 400，所以收在這一處：
//
//   模型                         關法                                  不帶參數時
//   ───────────────────────────────────────────────────────────────────────────
//   Sonnet 4.6 / Haiku 4.5 以前   不帶就不想                             不想
//   Sonnet 5 / Opus 5            thinking: disabled                     會想
//   Haiku 5.5                    thinking: disabled（effort ≤ high）    會想（medium）
//   Sonnet 5.5                   thinking: between_tools（disabled 400） 會想
//   Opus 5.5 / Fable / Mythos    關不掉：adaptive + effort low，另給餘裕  會想
//
// 閒聊不走這裡：它是刻意要「先想再答」的（chat.ts 的 chatThinking）。

/** 4.7 以後的世代換了 tokenizer，同一段文字約多出三成 token（Haiku 5.5 也是新 tokenizer）。
 *  MODE_LIMITS 這類長度是照舊 tokenizer 調的，不放大就會多出一批斷半句的回覆。 */
export const isNewTokenizer = (m: string) => /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable|mythos)/.test(m);

/** 關不掉思考的模型：只能壓到 effort low，max_tokens 要另加這麼多給它想。 */
const NO_OFF_HEADROOM = Number(Deno.env.get("THINK_HEADROOM_NO_OFF") ?? "1500");

/** 回傳要併進請求本體的欄位，以及 max_tokens 該再加多少。 */
export function noThinking(m: string): { body: Record<string, unknown>; headroom: number } {
  if (/^claude-sonnet-5-5/.test(m)) return { body: { thinking: { type: "between_tools" } }, headroom: 0 };
  if (/^claude-(opus-5-5|fable|mythos)/.test(m)) {
    return { body: { thinking: { type: "adaptive" }, output_config: { effort: "low" } }, headroom: NO_OFF_HEADROOM };
  }
  if (/^claude-((sonnet|opus)-5(?!-\d)|haiku-5)/.test(m)) return { body: { thinking: { type: "disabled" } }, headroom: 0 };
  return { body: {}, headroom: 0 };
}
