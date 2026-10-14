// monthly-quest.ts — 每月的非常規事件（六六 2026-10-14）
//
// 隱藏支線（0069）本來是三條永久的：角色在一處少去的地方，你跟他說話時問到那件事＝找到，
// 寄一封他的信夾靈石，每人每條一次。這裡讓它每個月換一批：月初由模型照人設與這陣子的起居注
// 寫三條（每位一條）——在哪、在做什麼、問到什麼算找到、信寫什麼。全站共用，每人各自去撞見。
//
// 何時寫：due-reminder 每天叫 ensureMonthQuests；這個月已經有了就什麼都不做。
// 模型寫壞（地點不存在、觸發詞不是合法正則、欄位缺）就丟掉那一條，不讓一條爛資料擋住別的。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { PLACES, ROUTINE } from "./whereabouts.ts";
import { logUsage } from "./services.ts";
import { noThinking } from "./model-params.ts";

const MODEL = Deno.env.get("QUEST_MODEL") ?? "claude-sonnet-5-5";
const LINGSHI = Number(Deno.env.get("QUEST_LINGSHI") ?? "10");
const NAMES: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀喵" };
const BANDS = "ndmzael";
const GENERIC_ASK = "在做什麼|在忙什麼|做什麼|在幹嘛";

/** 台北的年月 YYYY-MM。 */
export const twMonth = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 7);

/** 這個角色「平常不去」的地方：不在他的日常行程裡，也不是他那條永久支線的地方。 */
export function oddPlaces(charId: string, permanent: { character_id: string; place: string }[]): string[] {
  const usual = new Set((ROUTINE[charId] ?? []).map((a) => a.place));
  for (const q of permanent) if (q.character_id === charId) usual.add(q.place);
  return Object.keys(PLACES).filter((p) => !usual.has(p));
}

const WHO = `幾知觀：山中的小道觀。
・大師兄：首座弟子，冷峻精確、用詞精準且保守，有自閉症光譜式特質，被動、作息規律。拜觀裡的老貓為師、稱「師傅」，從不說破。
・師妹：二弟子，大戶人家私生女，十歲入觀。溫潤體面、很懂人也不太信人，管帳迎客張羅吃食。
・觀喵：修行多年的貓，通透沉靜、帶著老派的體面，其實是大師兄的「師傅」。`;

const SYS = `你替幾知觀寫這個月的「非常規事件」：三位各有一件，平常不會在那裡、不會做那件事——被人撞見會有點不好意思、或想藏著。
${WHO}

每一件寫成一個 JSON 物件，三件放在一個陣列裡，只輸出 JSON，不加任何說明：
[{"character":"daoshi_m","place":"<從給你的地點裡挑一個 key>","doing":"在<地名>（觀堂上顯示的那行，六字內）","bands":"<時段代碼>","hint":"<他在那裡時的處境：在做什麼、手邊有什麼、為什麼不想被看見。寫事實，不寫『要怎麼回答』>","found_hint":"<被撞見過一次之後再遇到時的處境>","ask":"<問到什麼算找到：幾個詞，用 | 隔開>","subject":"<信的標題，十字內>","body":"<他事後寫來的信，用他的口吻，八十到一百五十字，最後提一句附了幾顆靈石>"}, ...]

規則：
・這件事要合他的性格與身世，但是他平常不會做的一面（例：大師兄偷學做點心、師妹去後院偷練劍）。
・跟這個月的節氣、或這陣子觀裡的日子接得上更好。
・不要跟「之前寫過的」重複。
・時段代碼：n 深夜、d 清晨、m 上午、z 午間、a 午後、e 傍晚、l 夜，挑二到三個合理的。
・ask 的詞要是護道人撞見時自然會問的（那個地方、那件事、手上的東西）。
・古風：不出現今時器物。不寫戀愛告白。`;

type Draft = { character: string; place: string; doing: string; bands: string; hint: string; found_hint?: string; ask: string; subject: string; body: string };

/** 驗一條：不合格回 null。 */
export function validateDraft(d: Draft, allowed: Record<string, string[]>): Draft | null {
  if (!d || typeof d !== "object" || !NAMES[d.character]) return null;
  if (!allowed[d.character]?.includes(d.place)) return null;
  for (const k of ["doing", "hint", "ask", "subject", "body"] as const) if (typeof d[k] !== "string" || !d[k].trim()) return null;
  const bands = [...new Set((d.bands ?? "").split("").filter((c) => BANDS.includes(c)))].join("");
  if (!bands) return null;
  const ask = d.ask.split(/[|｜、，,]/).map((w) => w.trim().replace(/[.*+?^${}()[\]\\]/g, "")).filter(Boolean).join("|");
  if (!ask) return null;
  return { ...d, bands, ask: `${ask}|${GENERIC_ASK}`, doing: d.doing.slice(0, 12), subject: d.subject.slice(0, 20), body: d.body.slice(0, 600) };
}

/** 這個月的三條寫了沒；沒寫就寫。任何失敗都吞掉。回傳這個月現有幾條。 */
export async function ensureMonthQuests(db: SupabaseClient, now = Date.now()): Promise<number> {
  const month = twMonth(now);
  try {
    const { data: all, error } = await db.from("hidden_quests").select("id, character_id, place, doing, month, mail_subject");
    if (error) return 0;                                       // month 欄還沒上（0087 未跑）
    const mine = (all ?? []).filter((q) => q.month === month);
    if (mine.length >= 3) return mine.length;
    const permanent = (all ?? []).filter((q) => !q.month);
    const allowed = Object.fromEntries(Object.keys(NAMES).map((c) => [c, oddPlaces(c, permanent)]));
    const past = (all ?? []).filter((q) => q.month).slice(-9).map((q) => `${NAMES[q.character_id] ?? q.character_id}：${q.doing}（${q.mail_subject}）`);
    const { data: days } = await db.from("character_days").select("day, character_id, body").order("day", { ascending: false }).limit(9);
    const life = (days ?? []).map((r) => `${NAMES[r.character_id] ?? r.character_id}〔${String(r.day).slice(5)}〕${r.body}`).join("\n");
    const placeList = Object.entries(allowed).map(([c, ps]) => `${NAMES[c]}（${c}）可用地點：${ps.map((p) => `${p}=${PLACES[p]}`).join("、")}`).join("\n");
    const usr = `這個月：${month}。\n${placeList}\n\n之前寫過的：\n${past.join("\n") || "（沒有）"}\n\n這陣子觀裡的日子：\n${life || "（沒有紀錄）"}\n\n寫這個月的三件。`;

    const nt = noThinking(MODEL);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2500 + nt.headroom, system: SYS, messages: [{ role: "user", content: usr }], ...nt.body }),
    });
    if (!res.ok) { console.error("ensureMonthQuests api", res.status, await res.text()); return mine.length; }
    const data = await res.json();
    await logUsage(db, { userId: null, mode: "month_quest", model: MODEL, estimated: !data.usage,
      usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 } });
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    let drafts: Draft[] = [];
    try { drafts = JSON.parse(json); } catch { console.error("ensureMonthQuests parse", text.slice(0, 300)); return mine.length; }
    const have = new Set(mine.map((q) => q.character_id));
    const rows = [];
    for (const raw of drafts) {
      const d = validateDraft(raw, allowed);
      if (!d || have.has(d.character)) continue;
      have.add(d.character);
      rows.push({
        id: `${d.character === "daoshi_m" ? "m" : d.character === "daoshi_f" ? "f" : "c"}_${month.replace("-", "_")}`,
        character_id: d.character, place: d.place, doing: d.doing, bands: d.bands, weight: 1.2,
        hint: d.hint, found_hint: d.found_hint || null, ask_re: d.ask,
        mail_subject: d.subject, mail_body: d.body, lingshi: LINGSHI, active: true, month,
      });
    }
    if (rows.length) {
      const { error: insErr } = await db.from("hidden_quests").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (insErr) console.error("ensureMonthQuests insert", insErr.message);
    }
    return mine.length + rows.length;
  } catch (e) {
    console.error("ensureMonthQuests failed", e);
    return 0;
  }
}
