// _shared/reminder-voice.ts — 提醒的那一句話，用角色自己的口吻說（六六 2026-10-22）
//
// 手機跳出來的通知原本是「大師兄提醒」＋玩家自己打的標題，像鬧鐘不像人。
// 這裡在存提醒的那一刻寫好一句（通知是手機本機排的，跳出來那一刻沒有網路可以等），
// 存進 reminders.voice；之後每次排通知都用這一句。
//
// 成本：Haiku 一次，人設那段走快取，約 NT$0.01 上下。失敗或逾時就用下面的固定句，不擋存檔。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { noThinking } from "./model-params.ts";
import { logUsage } from "./services.ts";

const API = "https://api.anthropic.com/v1/messages";
const MODEL = Deno.env.get("REMINDER_MODEL") ?? Deno.env.get("CHAT_MODEL") ?? "claude-haiku-5-5";
export const CHAR_IDS = ["daoshi_m", "daoshi_f", "lingshou"] as const;

/** 模型不在或失敗時的固定句：{t}＝玩家打的事 */
const CANNED: Record<string, string[]> = {
  daoshi_m: ["{t}。時候到了。", "{t}——該動身了。", "記著：{t}。"],
  daoshi_f: ["{t}的時候到了，別忘了喔。", "提醒你一聲：{t}。慢慢來，別急。", "{t}——我替你記著呢。"],
  lingshou: ["喂，{t}。本喵記性比你好。", "{t}。還不快去，本喵要睡了。", "鏟屎的，{t}，別讓本喵說第二次。"],
};
export function cannedVoice(cid: string, title: string): string {
  const list = CANNED[cid] ?? CANNED.daoshi_m;
  return list[Math.floor(Math.random() * list.length)].replace("{t}", title).slice(0, 60);
}

const RULE = `【這一次的工作】護道人託你記一件事，時候到了要提醒他。寫「提醒他的那一句話」，會出現在他手機跳出來的通知上。
・一句，至多四十字，繁體中文（台灣用字）。照你平常的口吻與對他的稱呼。
・那件事的內容照他寫的說，不改事實、不加日期時間以外的細節；他寫的今時用字（開會、看牙醫、繳費）照用，不必改成古風。
・不要動作描寫（＊…＊）、不要引號、不要表情符號、不要問句結尾逼他回話。
・只輸出那一句，不要任何說明。`;

export async function voiceReminder(db: SupabaseClient, p: {
  userId: string; characterId: string; title: string; date: string; time?: string | null; leadDays?: number;
}): Promise<string> {
  const title = p.title.trim();
  try {
    const { data: ch } = await db.from("characters").select("persona_prompt").eq("id", p.characterId).maybeSingle();
    if (!ch?.persona_prompt) return cannedVoice(p.characterId, title);
    const when = `${p.date}${p.time ? " " + p.time : ""}${p.leadDays ? `（提前 ${p.leadDays} 天提醒）` : ""}`;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const nt = noThinking(MODEL);
      const res = await fetch(API, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL, max_tokens: 120 + nt.headroom, ...nt.body,
          system: [{ type: "text", text: `${ch.persona_prompt}\n\n${RULE}`, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: `他託你記的事：${title}\n時候：${when}` }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const data = await res.json();
      let text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
      text = text.replace(/^[「『"“]+|[」』"”]+$/g, "").replace(/＊[^＊]*＊/g, "").replace(/\s+/g, " ").trim();
      await logUsage(db, { userId: p.userId, mode: "reminder_voice", model: MODEL, estimated: !data.usage,
        usage: { in: data.usage?.input_tokens ?? 800, out: data.usage?.output_tokens ?? 40 } }).catch(() => {});
      return text && text.length <= 80 ? text : cannedVoice(p.characterId, title);
    } finally { clearTimeout(timer); }
  } catch (e) {
    console.error("reminder voice fail, canned", e instanceof Error ? e.message : String(e));
    return cannedVoice(p.characterId, title);
  }
}
