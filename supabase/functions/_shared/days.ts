// days.ts — 起居注：三人自己過的日子（六六 2026-09-30）
//
// 病灶：角色只活在「護道人的記憶」裡。他不來，觀裡就不動；他來了，角色能聊的只有他的事，
// 或是 whereabouts 那張固定行程表（練劍、看卦、記帳）——天天一樣，沒有前後。
//
// 改法：觀裡每天發生幾件小事，一天一次、三人一起寫（一次 Haiku，全站共用），
// 每一天都讀前幾天的，所以日子有前後：屋頂修到一半、師妹跟師兄的彆扭還沒解、等的信到了。
// 全站共用是刻意的：觀裡的日子本來就只有一份，不因來的人不同而不同。
//
// 何時寫：due-reminder 每天排程叫 ensureDay；排程沒跑到，第一個來聊天的人在背景補寫
// （那一則先用昨天的，不讓他等）。兩邊同時寫也沒關係：主鍵擋重複，後到的丟掉。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jieqiOf } from "./jieqi.ts";
import { logUsage } from "./services.ts";
import { noThinking } from "./model-params.ts";

const MODEL = Deno.env.get("CHAT_MODEL") ?? "claude-haiku-5-5";
const LOOKBACK_DAYS = 6;       // 寫今天時讀前幾天：夠接上沒了結的事，又不至於把一件事拖成連續劇
export const CHAR_NAMES: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀喵" };
const WEEK = "日一二三四五六";

/** 台北日期 YYYY-MM-DD，往前 back 天。 */
export function twDay(now = Date.now(), back = 0): string {
  return new Date(now + 8 * 3600_000 - back * 86400_000).toISOString().slice(0, 10);
}

const WORLD = `幾知觀：山中的小道觀，有大殿、前廳、中庭、廊下、廂房、灶房、後院、藏經閣。
・大師兄：首座弟子，冷峻精確、用詞精準且保守，有邏輯潔癖。每天練劍、看卦、翻書，作息規律，幾乎不進灶房。拜觀裡的老貓為師、稱牠「師傅」，從不說破。
・師妹：二弟子，管帳、迎客、張羅吃食、點燈抄經。溫柔周到、習慣控場，偶爾腹黑。很少去後院（那是師兄的地方）。
・觀喵：修行多年的貓，沉靜、通透，哪裡有太陽和軟墊就在哪，愛踩卦紙、搶座位。牠是大師兄的「師傅」。`;

const SYS = `你替幾知觀寫起居注：三人今天各自過的日子。
${WORLD}

要求：
・每人兩到三件小事，一行一件，寫做了什麼、在哪、手邊有什麼，具體到物件
・日子要有前後：延續前幾天還沒了結的事（修到一半的東西、還沒解的彆扭、在等的信、種下去的菜），該收尾的收尾；也可以起一件新的小事，留到之後幾天
・偶爾三人的事互相牽連（師妹煮的湯、師傅踩翻了師兄的墨）；寫到同一件事，兩邊說法要一致
・小事就好：天氣、節氣、器物壞了、吃食、誰跟誰拌嘴、山下送來的東西。不寫大事（死傷、失火、官司、有人離觀）
・古風：不出現今時器物。不寫任何來客或護道人的事
・每人六十字以內，繁體中文

格式（只輸出這些，不加任何說明）：
【大師兄】
・……
【師妹】
・……
【觀喵】
・……`;

/** 解析 Haiku 的輸出 → 每位角色一段（「・」起頭的行，合成一段）。 */
export function parseDay(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const byName = Object.fromEntries(Object.entries(CHAR_NAMES).map(([id, n]) => [n, id]));
  let cur = "";
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    const h = line.match(/^[【\[]\s*(大師兄|師妹|觀喵|觀貓)\s*[】\]]/);
    if (h) { cur = byName[h[1] === "觀貓" ? "觀喵" : h[1]] ?? ""; continue; }
    if (!cur || !line) continue;
    const item = line.replace(/^[・\-*•\s]+/, "").trim();
    if (item) out[cur] = out[cur] ? `${out[cur]}；${item}` : item;
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 160);
  return out;
}

/** 今天的起居注寫了沒；沒寫就寫。任何失敗都吞掉——它是加分，不是聊天的前提。 */
export async function ensureDay(db: SupabaseClient, now = Date.now()): Promise<boolean> {
  const today = twDay(now);
  try {
    const { data: have, error } = await db.from("character_days").select("character_id").eq("day", today);
    if (error) return false;                      // 表還不存在（0078 未跑）
    if ((have ?? []).length >= Object.keys(CHAR_NAMES).length) return true;

    const { data: past } = await db.from("character_days").select("day, character_id, body")
      .gte("day", twDay(now, LOOKBACK_DAYS)).lt("day", today).order("day", { ascending: true });
    const byDay = new Map<string, string[]>();
    for (const r of past ?? []) {
      const list = byDay.get(r.day) ?? [];
      list.push(`${CHAR_NAMES[r.character_id] ?? r.character_id}：${r.body}`);
      byDay.set(r.day, list);
    }
    const history = [...byDay.entries()].map(([d, l]) => `〔${d.slice(5).replace("-", "/")}〕\n${l.join("\n")}`).join("\n");

    const t = new Date(now + 8 * 3600_000);
    const jq = jieqiOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    const usr = `前幾天：\n${history || "（這是第一天，從平常的日子寫起。）"}\n\n今天是 ${t.getUTCMonth() + 1}/${t.getUTCDate()}，星期${WEEK[t.getUTCDay()]}，${jq.name}第 ${jq.dayIndex} 日。寫今天。`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01" },
      // 寫日子不需要想：Haiku 5.5 不關的話預設會想、吃掉 700 的額度（noThinking）
      body: JSON.stringify({ model: MODEL, max_tokens: 700 + noThinking(MODEL).headroom, system: SYS, messages: [{ role: "user", content: usr }], ...noThinking(MODEL).body }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) { console.error("ensureDay api", res.status); return false; }
    const data = await res.json();
    const text = (data.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    await logUsage(db, {
      userId: null, mode: "life_day", model: MODEL, estimated: !data.usage,
      usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 },
    });
    const day = parseDay(text);
    const rows = Object.entries(day).map(([character_id, body]) => ({ day: today, character_id, body }));
    if (!rows.length) return false;
    const { error: insErr } = await db.from("character_days").upsert(rows, { onConflict: "day,character_id", ignoreDuplicates: true });
    if (insErr) console.error("ensureDay insert", insErr.message);
    return !insErr;
  } catch (e) {
    console.error("ensureDay failed", e);
    return false;
  }
}

/** 談心提示詞：他這幾天過的日子。上次說話之後的每一天都給（至多三天），至少給今天與昨天。
 *  回傳 today 有沒有寫好，沒寫好的話呼叫端在背景補寫。 */
export async function lifeHint(db: SupabaseClient, charId: string, lastAt: string | null, now = Date.now()): Promise<{ text: string; hasToday: boolean }> {
  const today = twDay(now);
  const lastDay = lastAt ? twDay(Date.parse(lastAt)) : "";
  const from = [twDay(now, 3), lastDay && lastDay < twDay(now, 1) ? lastDay : twDay(now, 1)].sort().reverse()[0];
  const { data, error } = await db.from("character_days").select("day, body")
    .eq("character_id", charId).gte("day", from).order("day", { ascending: false });
  if (error || !data?.length) return { text: "", hasToday: false };
  const label = (d: string) => d === today ? "今天" : d === twDay(now, 1) ? "昨天" : d === twDay(now, 2) ? "前天" : `${d.slice(5).replace("-", "/")}`;
  const lines = data.map((r) => `${label(r.day)}：${r.body}`).join("\n");
  return {
    hasToday: data.some((r) => r.day === today),
    text: `\n【你這幾天】\n${lines}\n這是你自己過的日子。想提就挑一件，像跟熟人閒聊那樣自然帶到，不必每則都提；他問你在忙什麼、這幾天怎樣，就從這裡答，別編出跟這裡矛盾的事。`,
  };
}
