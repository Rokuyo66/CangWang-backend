// _shared/whereabouts.ts — 三人此刻在觀裡哪裡、在做什麼；以及隱藏支線的判定。
//
// 【為什麼在後端】
//   隱藏支線要驗「你問的那一刻，他真的在灶房」。位置若由前端算，改一下時鐘或程式
//   就能讓師兄永遠待在灶房。所以位置由這裡抽，觀堂與談心都來問這裡。
//
// 【怎麼抽】
//   一天切成十二格（台北時間每兩小時一格）。每格依該時段可能的行程加權抽一個。
//   種子＝使用者＋角色＋日期＋格，所以：
//     ・同一格內怎麼刷新都一樣（不會一開觀堂他在廊下、點進去變灶房）
//     ・換一格才換地方
//     ・每個人看到的不一樣
//   一般行程寫在這裡（改了要 deploy）；少去的那一處在 hidden_quests 表（改了即生效）。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** 場景 key → 地名。key 與前端 Scene 的 scene/<key> 同一組。 */
export const PLACES: Record<string, string> = {
  guanmen: "觀門", qianting: "前廳", dadian: "大殿", zhongting: "中庭", langxia: "廊下",
  xiangfang: "廂房", zaofang: "灶房", houyuan: "後院", wuji: "屋脊", cangjingge: "藏經閣",
};

/** 時段：n 深夜 0–5／d 清晨 5–9／m 上午 9–12／z 午間 12–14／a 午後 14–18／e 傍晚 18–22／l 夜 22–24 */
export function bandOf(hour: number): string {
  return hour < 5 ? "n" : hour < 9 ? "d" : hour < 12 ? "m" : hour < 14 ? "z" : hour < 18 ? "a" : hour < 22 ? "e" : "l";
}

type Act = { place: string; doing: string; bands: string; w: number };

/* 一般行程。依人設排：
   師兄——練劍、看卦、翻書，作息規律，幾乎不碰灶房（那是他的隱藏支線）。
   師妹——管帳、灑掃、張羅吃食、點燈抄經；後院是師兄的地方，她很少去（隱藏支線）。
   觀喵——哪裡有太陽、有軟墊就在哪；藏經閣是牠「不該會去」的地方（隱藏支線）。 */
export const ROUTINE: Record<string, Act[]> = {
  daoshi_m: [
    { place: "houyuan",    doing: "在後院練劍",     bands: "de", w: 5 },
    { place: "houyuan",    doing: "在後院收劍",     bands: "e",  w: 2 },
    { place: "dadian",     doing: "在大殿看卦",     bands: "mza", w: 5 },
    { place: "dadian",     doing: "在大殿替人排盤", bands: "ma", w: 2 },
    { place: "cangjingge", doing: "在藏經閣翻書",   bands: "mal", w: 4 },
    { place: "cangjingge", doing: "在藏經閣抄卦例", bands: "nl", w: 2 },
    { place: "langxia",    doing: "在廊下喝茶",     bands: "za", w: 4 },
    { place: "zhongting",  doing: "在中庭看天色",   bands: "de", w: 2 },
    { place: "guanmen",    doing: "在觀門送客",     bands: "ma", w: 1 },
    { place: "xiangfang",  doing: "在廂房擦劍",     bands: "el", w: 2 },
    { place: "xiangfang",  doing: "還沒睡",         bands: "nl", w: 5 },
  ],
  daoshi_f: [
    { place: "qianting",   doing: "在前廳記帳",     bands: "ma", w: 5 },
    { place: "qianting",   doing: "在前廳迎客",     bands: "ma", w: 3 },
    { place: "zaofang",    doing: "在灶房張羅",     bands: "dze", w: 4 },
    { place: "zhongting",  doing: "在灑掃庭院",     bands: "d",  w: 4 },
    { place: "zhongting",  doing: "在中庭晾衣",     bands: "ma", w: 2 },
    { place: "langxia",    doing: "在廊下點燈",     bands: "e",  w: 4 },
    { place: "langxia",    doing: "在廊下縫補",     bands: "a",  w: 2 },
    { place: "dadian",     doing: "在大殿上香",     bands: "de", w: 3 },
    { place: "guanmen",    doing: "在觀門收信",     bands: "m",  w: 2 },
    { place: "cangjingge", doing: "在藏經閣整理帳冊", bands: "a", w: 1 },
    { place: "xiangfang",  doing: "在燈下抄經",     bands: "nl", w: 5 },
  ],
  lingshou: [
    { place: "guanmen",    doing: "在門口曬太陽",   bands: "dm", w: 4 },
    { place: "dadian",     doing: "在香案上打盹",   bands: "ma", w: 4 },
    { place: "dadian",     doing: "在蒲團上打盹",   bands: "za", w: 4 },
    { place: "zhongting",  doing: "在中庭追落葉",   bands: "da", w: 2 },
    { place: "zhongting",  doing: "眼睛亮著",       bands: "nl", w: 3 },
    { place: "wuji",       doing: "在屋脊上巡視",   bands: "en", w: 4 },
    { place: "langxia",    doing: "在廊下舔爪",     bands: "zae", w: 3 },
    { place: "zaofang",    doing: "在灶房門口蹲著", bands: "ze", w: 3 },
    { place: "qianting",   doing: "在前廳帳簿上趴著", bands: "ma", w: 2 },
    { place: "xiangfang",  doing: "在廂房窩著",     bands: "nl", w: 2 },
  ],
};

export type Quest = {
  id: string; character_id: string; place: string; doing: string; bands: string; weight: number;
  hint: string; found_hint: string | null; ask_re: string;
};
export type Where = {
  place: string; placeName: string; doing: string;
  quest: Quest | null;                 // 此刻正在隱藏支線那一處（不論找到過沒有）
};

/** 台北時間的日期與時格（0–11）。now 可注入，測試用。 */
export function slotOf(now = Date.now()): { date: string; slot: number; hour: number; endsAt: number } {
  const t = new Date(now + 8 * 3600_000);
  const hour = t.getUTCHours();
  const slot = Math.floor(hour / 2);
  const startUtc = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), slot * 2) - 8 * 3600_000;
  return { date: t.toISOString().slice(0, 10), slot, hour, endsAt: startUtc + 2 * 3600_000 };
}

/** FNV-1a → [0,1)。不用 Math.random：同一格內必須每次抽到同一個。 */
function unit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

/** 純函式：給定行程池與隱藏支線，抽出此刻的位置。 */
export function pickWhere(uid: string, charId: string, quests: Quest[], now = Date.now()): Where | null {
  const pool = ROUTINE[charId];
  if (!pool) return null;
  const { date, slot } = slotOf(now);
  const b = bandOf(slot * 2);   // 以時格起點定時段：格內不換時段，位置才不會半途跳
  const cands: { act: Act; quest: Quest | null }[] = pool.filter((a) => a.bands.includes(b)).map((act) => ({ act, quest: null }));
  for (const q of quests) {
    if (q.character_id === charId && q.bands.includes(b)) {
      cands.push({ act: { place: q.place, doing: q.doing, bands: q.bands, w: q.weight }, quest: q });
    }
  }
  if (!cands.length) return null;
  const total = cands.reduce((s, c) => s + c.act.w, 0);
  let r = unit(`${uid}|${charId}|${date}|${slot}`) * total;
  for (const c of cands) {
    r -= c.act.w;
    if (r < 0) return { place: c.act.place, placeName: PLACES[c.act.place] ?? c.act.place, doing: c.act.doing, quest: c.quest };
  }
  const c = cands[cands.length - 1];
  return { place: c.act.place, placeName: PLACES[c.act.place] ?? c.act.place, doing: c.act.doing, quest: c.quest };
}

// 支線表一個 isolate 快取五分鐘：每句閒聊都查一次不划算，改表之後最多五分鐘生效。
let questCache: { at: number; rows: Quest[] } | null = null;
export async function activeQuests(db: SupabaseClient): Promise<Quest[]> {
  if (questCache && Date.now() - questCache.at < 300_000) return questCache.rows;
  const { data, error } = await db.from("hidden_quests")
    .select("id, character_id, place, doing, bands, weight, hint, found_hint, ask_re").eq("active", true);
  if (error) { console.error("hidden_quests read failed", error.message); return questCache?.rows ?? []; }
  questCache = { at: Date.now(), rows: (data ?? []) as Quest[] };
  return questCache.rows;
}
export const __resetQuestCache = () => { questCache = null; };

export async function whereNow(db: SupabaseClient, uid: string, charId: string, now = Date.now()): Promise<Where | null> {
  return pickWhere(uid, charId, await activeQuests(db), now);
}

/** 觀堂用：三人此刻所在＋這一格什麼時候結束（前端到點再問一次）。不透露哪一處是支線。 */
export async function whereaboutsAll(db: SupabaseClient, uid: string, now = Date.now()) {
  const quests = await activeQuests(db);
  const chars: Record<string, { place: string; placeName: string; doing: string }> = {};
  for (const id of Object.keys(ROUTINE)) {
    const w = pickWhere(uid, id, quests, now);
    if (w) chars[id] = { place: w.place, placeName: w.placeName, doing: w.doing };
  }
  return { chars, endsAt: new Date(slotOf(now).endsAt).toISOString() };
}

/** 談心提示詞裡的那一段：在哪、在做什麼；在支線那一處時多一段「你此刻的處境」。 */
export async function whereHint(db: SupabaseClient, uid: string, w: Where | null): Promise<{ doing: string; secret: string }> {
  if (!w) return { doing: "", secret: "" };
  if (!w.quest) return { doing: w.doing, secret: "" };
  const { data } = await db.from("hidden_found").select("quest_id").eq("user_id", uid).eq("quest_id", w.quest.id).maybeSingle();
  const text = data ? (w.quest.found_hint || w.quest.hint) : w.quest.hint;
  return { doing: w.doing, secret: `【你此刻的處境】${text}` };
}

/** 這句話算不算「問到了」。ask_re 是表裡的字，寫壞了就當沒命中，不讓一列爛資料擋住聊天。 */
export function asksAbout(q: Quest, message: string): boolean {
  try { return new RegExp(q.ask_re, "i").test(message); } catch { return false; }
}

/** 他在支線那一處、你問到了 → 記一筆、寄信。回傳這次有沒有剛找到。 */
export async function tryHiddenFound(db: SupabaseClient, uid: string, w: Where | null, message: string):
  Promise<{ questId: string; mailId: string | null; lingshi: number } | null> {
  if (!w?.quest || !asksAbout(w.quest, message)) return null;
  const { data, error } = await db.rpc("hidden_quest_claim", { p_user: uid, p_quest: w.quest.id });
  if (error) { console.error("hidden_quest_claim failed", error.message); return null; }
  const r = data as { ok?: boolean; mail_id?: string; lingshi?: number } | null;
  return r?.ok ? { questId: w.quest.id, mailId: r.mail_id ?? null, lingshi: r.lingshi ?? 0 } : null;
}

/** 上次說話到現在，他照常過的日子：往回每兩小時抽一格，取不重複的至多三件（不含此刻、不含隱藏支線——
 *  支線是要人撞見的，不能由他自己說出口）。給談心的時間感用，見 chat.ts timeGapHint。 */
export async function sinceDoings(db: SupabaseClient, uid: string, charId: string, from: number, now = Date.now()): Promise<string[]> {
  const quests = await activeQuests(db);
  const out: string[] = [];
  const cur = pickWhere(uid, charId, quests, now)?.doing;
  for (let t = now - 2 * 3600_000, n = 0; t > from && n < 24 && out.length < 3; t -= 2 * 3600_000, n++) {
    const w = pickWhere(uid, charId, quests, t);
    if (!w || w.quest || w.doing === cur || out.includes(w.doing)) continue;
    out.push(w.doing);
  }
  return out;
}

const NAMES: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀喵" };

/** 談心用：此刻觀裡三人各在哪（六六 2026-10-02：觀堂上明明看到觀喵和師妹都在廂房，
 *  問觀喵「你在陪師妹抄經嗎」，牠說師妹在雜房、小子在藏經閣——角色只知道自己在哪，
 *  另外兩人的位置是編的）。跟觀堂同一個抽法、同一個種子，所以他看到的就是角色知道的。 */
export function hereLine(uid: string, charId: string, quests: Quest[], now = Date.now()): string {
  const all = Object.keys(ROUTINE).map((id) => ({ id, w: pickWhere(uid, id, quests, now) }))
    .filter((x): x is { id: string; w: Where } => !!x.w);
  if (!all.length) return "";
  const me = all.find((x) => x.id === charId);
  const parts = all.map((x) => `${x.id === charId ? "你" : NAMES[x.id]}在${x.w.placeName}（${x.w.doing}）`);
  const together = me ? all.filter((x) => x.id !== charId && x.w.place === me.w.place).map((x) => NAMES[x.id]) : [];
  return `【此刻觀裡】${parts.join("；")}。${together.length ? `你和${together.join("、")}在同一處。` : ""}他在觀堂看得到你們三個各在哪。`;
}
