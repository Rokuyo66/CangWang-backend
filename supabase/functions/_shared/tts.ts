// _shared/tts.ts — 解卦朗讀的伺服端合成層（MiniMax t2a_v2）。
//
// 為什麼搬到伺服器：裝置內建的語音只有一把嗓子，性別由手機決定，我們指定不了；
// Android WebView 上還常常整個沒有中文語音資料。走雲端才給得起「師兄有師兄的
// 聲音」，但那就多了三件前端擔不起的事——金鑰、成本、快取。
//
// ⚠ 客戶端不送文字，只送 cast_id。
// 開放「你給我一段字，我念給你聽」等於把金鑰做成公用 TTS：任何拿得到 JWT 的人
// 都能拿它念小說，帳單記在觀主頭上。所以要念什麼一律由伺服器自己去 casts 撈，
// 客戶端只能指名「哪一卦的哪一段」——與整個專案「客戶端只送我做了什麼」同一條鐵則。
//
// ⚠ 一律先查快取。同一段批文被重聽第二次是常態（人聽完會再聽一次），
// 每次都重新合成就是每次都付一次錢。鍵是 模型＋聲線＋逐字文本 的雜湊：
// 三者任一改變都該是新的音檔，其餘情況一定命中。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { TTS_MODEL, VOICE_NARRATOR, voiceOf } from "./voices.ts";

const API_URL = Deno.env.get("MINIMAX_TTS_URL") ?? "https://api.minimax.io/v1/t2a_v2";
const API_KEY = Deno.env.get("MINIMAX_API_KEY") ?? "";
// 模型可用環境變數蓋掉：不同帳號開通的型號不一樣，寫死會讓換型號變成改程式。
const MODEL = Deno.env.get("MINIMAX_TTS_MODEL") ?? TTS_MODEL;
const BUCKET = Deno.env.get("TTS_BUCKET") ?? "tts";
// 每月合成字數上限，依玉牒分階。命中快取不算——重聽不該吃額度。
//
// 為什麼是「月」不是「日」：朗讀不是每天均勻消耗的東西。人是問到一卦特別
// 有感的那天，把批文連同三則追問一起聽完，然後好幾天不碰。日上限會在那一天
// 擋住他，而那天正是這功能最有價值的一天。月額度讓他自己決定要花在哪幾天。
//
// 為什麼要分階：TTS 是照字數計費的（speech-2.8-hd 約 US$0.10／千字），
// 而在此之前這裡是一個全站共用的數字——無牒與藏往每天能聽的量一樣多。
// 語音收藏格數分了四階，產生語音的字數卻沒分，等於擋住了「能留幾段」
// 卻沒擋住真正在花錢的那一端。
export const PLAN_TTS_CHARS: Record<string, number> =
  { free: 5000, guanwei: 12000, zhiji: 30000, cangwang: 60000 };

/** 一篇批文大約幾個字。**估的**，用來把額度講成「還能念幾段」——
 *  沒有人知道 1580 個字是多少東西，但每個人都知道 3 段是多少。
 *  MODE_LIMITS.cast 是 1000 tokens，中文一字約 1～1.5 token，
 *  再加上「所問：…」那一行，量級落在一千出頭。
 *  要校準就量：select round(avg(length(coalesce(question,'')||coalesce(reading,''))))
 *              from casts where coalesce(category,'') <> '日運' and reading is not null; */
export const CHARS_PER_READING = 1300;

// 全站緊急旋鈕：帳單失控時不必改程式重新部署，設 0.5 就是全體對半砍。
const SCALE = Number(Deno.env.get("TTS_MONTHLY_SCALE") ?? "1");

export const ttsQuotaOf = (plan: string) =>
  Math.max(0, Math.round((PLAN_TTS_CHARS[plan] ?? PLAN_TTS_CHARS.free) * (Number.isFinite(SCALE) ? SCALE : 1)));

// 日上限只是煞車，不是額度：跑掉的迴圈不該在一個下午燒完整個月。
// 取月額度的四分之一，正常人碰不到——碰得到的那種用法本來就該停下來看一眼。
export const dailyCapOf = (monthly: number) => Math.max(3000, Math.ceil(monthly / 4));

/** 台北日期。tts_usage.day 以前寫的是 UTC 日期，等於每日額度在台北時間
 *  早上八點重置——對使用者而言那是「昨天的量還沒還我」。刻意在這裡自己算，
 *  不 import services.ts（它載入時就讀 Deno.env，會讓這一層離線測不動）。 */
export const taipeiToday = (d = new Date()) =>
  new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
// 單次請求的字數上限。超過就切成多段、各自合成，前端照順序播。
// 不在伺服器把 mp3 接起來：裸接 frame 只是「多半能播」，遇到參數不同的段落
// 會播出雜音或提早結束，而那種壞法在測試機上未必重現得出來。
const CHUNK = Number(Deno.env.get("TTS_CHUNK_CHARS") ?? "600");

export type TtsResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

/* ── 文本整理 ──────────────────────────────────────────────────────
   與前端 reading-tts.js 的 ttsPlain 同一套規則，但這裡才是正本：
   快取鍵吃的是整理後的字，規則若兩邊各寫一份，改了其中一邊就會讓
   同一段批文產生兩個鍵、付兩次錢。 */
const NARRATION = /[*＊]([^*＊\n]+)[*＊]/g;

/** 一段話 ＋ 誰來念。narrator 為真＝旁白那把嗓子。 */
export type Seg = { narrator: boolean; text: string };

/** 洗掉只給眼睛看的記號：HTML、粗體星號、標題井號、清單符號、分隔線。
 *  ＊…＊ 留著——那是旁白的界線，要留到分軌那一步才處理。 */
const cleanLine = (l: string) =>
  l.replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,4}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();

/** 把批文切成「誰念哪一段」。
 *
 *  ＊……＊ 是旁白（「＊他沒有轉身，只是用眼神落在你身上＊」），其餘是角色說的話。
 *  以前這裡是把旁白整段丟掉的，理由是裝置語音只有一把嗓子——旁白與台詞用同一個
 *  聲音連著念，聽起來像有人在自言自語地描述自己。現在旁白有自己的嗓子
 *  （VOICE_NARRATOR），那個理由就不成立了，丟掉反而是把戲丟掉一半。
 *
 *  相鄰同一把嗓子的片段會合併。不合併的話，「台詞／旁白／台詞」三行就是三次
 *  付費請求；合併之後只有真正換嗓子的地方才切，該付的才付。 */
export function segments(md: string): Seg[] {
  const raw: Seg[] = [];
  for (const line of String(md || "").split(/\n+/)) {
    const l = cleanLine(line);
    if (!l || /^[-–—]{2,}$/.test(l)) continue;
    let at = 0;
    NARRATION.lastIndex = 0;
    for (let m = NARRATION.exec(l); m; m = NARRATION.exec(l)) {
      const before = l.slice(at, m.index).trim();
      if (before) raw.push({ narrator: false, text: before });
      const inner = m[1].trim();
      if (inner) raw.push({ narrator: true, text: inner });
      at = m.index + m[0].length;
    }
    const tail = l.slice(at).trim();
    if (tail) raw.push({ narrator: false, text: tail });
  }
  // 相鄰同嗓合併：換行當停頓，跟 chunk() 對段落的處理一致
  const out: Seg[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && last.narrator === s.narrator) last.text += "\n" + s.text;
    else out.push({ ...s });
  }
  return out;
}

/** 只留給耳朵聽的字（不分嗓子）。用來判斷「這一段有沒有東西可念」，
 *  以及在需要一整串純文字時（例如錯誤訊息）取用。 */
export function speakable(md: string): string {
  return segments(md).map((s) => s.text).join("\n");
}

/** 切段。只在句末切，不硬切字數——切在句子中間會聽見半句話戛然而止。
 *
 *  ⚠ 段落邊界不是切點。前端那份（reading-tts.js）是逐段落切的，在那裡不要緊：
 *  瀏覽器合成不花錢，段落之間的停頓還比較自然。搬到雲端之後每一段就是一次
 *  付費請求——四行批文切成四段，等於同一篇解卦付四次錢、跑四趟往返。
 *  所以這裡跨段落一直裝到 cap 為止，只留換行當停頓記號。 */
export function chunk(text: string, cap = CHUNK): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => { const s = buf.trim(); if (s) out.push(s); buf = ""; };
  for (const para of String(text).split(/\n+/)) {
    if (!para.trim()) continue;
    for (const seg of para.split(/(?<=[。！？；：!?;])/)) {
      if (!seg.trim()) continue;
      if ((buf + seg).length > cap && buf) flush();
      buf += seg;
    }
    if (buf) buf += "\n";   // 段落之間留一個換行：合成時是自然的停頓
  }
  flush();
  // 單句就超過上限（沒有標點的長串）時只好硬切，否則整包送不出去
  return out.flatMap((s) =>
    s.length <= cap ? [s] : s.match(new RegExp(`.{1,${cap}}`, "gs")) ?? []
  );
}

/* ── 回應解碼 ─────────────────────────────────────────────────────
   範例只給了請求形狀，沒給回應。output_format 有 hex 也有 base64，
   不同型號／版本吐的欄位不完全一樣——所以這裡不賭單一形狀：
   兩種編碼都試，並用 mp3 的檔頭驗收。驗不過就把「看到了哪些鍵」帶回去，
   下次不必再猜。 */
const isMp3 = (b: Uint8Array) =>
  b.length > 4 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) ||  // "ID3"
                   (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));            // frame sync

export function decodeAudio(s: string): Uint8Array | null {
  const t = s.trim();
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) {
    const b = new Uint8Array(t.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(t.substr(i * 2, 2), 16);
    if (isMp3(b)) return b;
  }
  try {
    const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    if (isMp3(b)) return b;
  } catch { /* 不是 base64 */ }
  return null;
}

const sha256 = async (s: string) => {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/* ── 要念哪些字 ───────────────────────────────────────────────────
   切嗓（誰念）與切段（一段一個音檔）只寫在這裡一份。朗讀走這條、
   事後把逐字稿補回收藏也走這條——兩邊各切一次的話，補回來的字會與
   當初念的那幾段對不上，畫面上就會用甲段的字配乙段的聲音。 */

/** 一小段：一段文字＝一個音檔。narrator 為真＝旁白那把嗓子。 */
export interface Piece { voiceId: string; text: string; narrator: boolean }

export function piecesOf(source: string, charVoice: string): Piece[] {
  const out: Piece[] = [];
  for (const seg of segments(source)) {
    const voiceId = seg.narrator ? VOICE_NARRATOR : charVoice;
    for (const text of chunk(seg.text)) out.push({ voiceId, text, narrator: seg.narrator });
  }
  return out;
}

/** 念什麼一律伺服器決定。這兩個組法就是快取鍵吃的那份原文，
 *  改動它等於讓全站的音檔重新合成一次——要改先想清楚。 */
const bodySource = (c: { question?: string | null; reading?: string | null }) =>
  [c.question ? `所問：${c.question}。` : "", c.reading ?? ""].filter(Boolean).join("\n");
const followupSource = (f: { question?: string | null; answer?: string | null }) =>
  [`所問：${f.question}。`, f.answer].filter(Boolean).join("\n");

/* ── 合成一段 ───────────────────────────────────────────────────── */
type Fetch = typeof fetch;

async function synth(text: string, voiceId: string, doFetch: Fetch): Promise<Uint8Array> {
  const r = await doFetch(API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      text,
      stream: false,
      voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      language_boost: "Chinese",
      output_format: "hex",
    }),
  });
  if (!r.ok) throw new Error(`minimax ${r.status}`);
  const j = await r.json().catch(() => null) as Record<string, any> | null;
  if (!j) throw new Error("minimax 回應不是 JSON");

  // base_resp.status_code 非 0 時 HTTP 仍可能是 200——不看這一欄會把錯誤當音檔存起來
  const code = j?.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    throw new Error(`minimax ${code}：${j?.base_resp?.status_msg ?? "未知錯誤"}`);
  }
  const raw = j?.data?.audio ?? j?.audio ?? j?.data?.audio_file;
  if (typeof raw !== "string" || !raw) {
    throw new Error(`minimax 回應沒有音檔欄位（看到的鍵：${Object.keys(j).join(",")}）`);
  }
  const bytes = decodeAudio(raw);
  if (!bytes) throw new Error("minimax 音檔既不是 hex 也不是 base64 的 mp3");
  return bytes;
}

/* ── 額度 ─────────────────────────────────────────────────────────
   月用量不另開一張表：tts_usage 本來就是一天一列，把當月那幾列加起來就是
   月用量。日列照寫，同時當日上限的煞車與事後查帳的流水——多一張彙總表就多
   一個會跟明細走偏的地方。 */

/** 這個月的第一天與下個月的第一天（台北），拿來框當月那幾列。 */
export function monthRange(today = taipeiToday()): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${y}-${pad(m)}-01`, to: `${nextY}-${pad(nextM)}-01` };
}

export interface TtsQuota {
  used: number; max: number; left: number; day_used: number; day_max: number;
  /** 還能念幾段（估）。無條件捨去——說還有 2 段結果念得出 3 段是驚喜，反過來是失信。 */
  left_readings: number;
}

/** 讀額度，不動它。給 profile 用——畫面上要說得出「本月還能請人念幾段」。 */
export async function ttsQuota(db: SupabaseClient, uid: string, plan: string): Promise<TtsQuota> {
  const max = ttsQuotaOf(plan);
  const day = taipeiToday();
  const { from, to } = monthRange(day);
  const { data } = await db.from("tts_usage").select("day, chars")
    .eq("user_id", uid).gte("day", from).lt("day", to);
  const rows = (data ?? []) as { day: string; chars: number | null }[];
  const used = rows.reduce((n, r) => n + Number(r.chars ?? 0), 0);
  const dayUsed = Number(rows.find((r) => r.day === day)?.chars ?? 0);
  const left = Math.max(0, max - used);
  return {
    used, max, left, day_used: dayUsed, day_max: dailyCapOf(max),
    left_readings: Math.floor(left / CHARS_PER_READING),
  };
}

/** 扣額度。ok:false＝不夠，呼叫端不要合成。
 *  匯出是為了測得到——這是整條線上唯一擋住帳單的那道門。 */
export async function spendQuota(
  db: SupabaseClient, uid: string, plan: string, chars: number,
): Promise<{ ok: true } | { ok: false; msg: string }> {
  const day = taipeiToday();
  const q = await ttsQuota(db, uid, plan);
  // 訊息帶數字：只說「用完了」的話，回報進來時查不出是差一點還是差很多，
  // 而那兩件事要做的處置完全不同（等下個月／額度訂得太小）。
  const need = `這一段要 ${chars} 字，本月還剩 ${q.left} 字`;
  if (q.used + chars > q.max) {
    return {
      ok: false,
      msg: q.max === PLAN_TTS_CHARS.free
        ? `這個月的朗讀額度不夠了（${need}）。已經收藏的還是能聽——持玉牒入觀，額度會多很多。`
        : `這個月的朗讀額度不夠了（${need}），下個月一號重新計算。已經收藏的還是能聽。`,
    };
  }
  if (q.day_used + chars > q.day_max) {
    return { ok: false, msg: `今天念得夠多了，明天再來——這個月的額度還在（剩 ${q.left} 字）。` };
  }
  await db.from("tts_usage").upsert(
    { user_id: uid, day, chars: q.day_used + chars },
    { onConflict: "user_id,day" },
  );
  return { ok: true };
}

/* ── 對外：念某一卦的某一段 ─────────────────────────────────────── */
export async function speakCast(
  db: SupabaseClient,
  uid: string,
  plan: string,
  castId: string,
  part: "body" | number,
  doFetch: Fetch = fetch,
): Promise<TtsResult> {
  if (!API_KEY) return { ok: false, msg: "伺服器尚未設定語音金鑰" };
  if (!castId) return { ok: false, msg: "沒說要念哪一卦" };

  const { data: cast } = await db.from("casts")
    .select("id, user_id, character_id, question, reading, gua_ben")
    .eq("id", castId).eq("user_id", uid).maybeSingle();
  if (!cast) return { ok: false, msg: "找不到這一卦" };

  // 念什麼一律伺服器決定：body＝提問＋批文，數字＝第幾則追問的一問一答
  let source = "";
  if (part === "body" || part == null) {
    source = bodySource(cast);
  } else {
    const { data: fups } = await db.from("followups")
      .select("question, answer").eq("cast_id", castId).order("created_at");
    const f = (fups ?? [])[Number(part)];
    if (!f) return { ok: false, msg: "沒有這一則追問" };
    source = followupSource(f);
  }

  return await speakSource(db, uid, plan, {
    source,
    charVoice: voiceOf(cast.character_id),
    title: titleOf(cast, part),
    subtitle: cast.question ?? null,
    characterId: cast.character_id ?? null,
  }, doFetch);
}

/* ── 對外：念閒聊裡的某一句 ─────────────────────────────────────
   同一條鐵則：客戶端只送 chat_id，不送文字。念哪一句由伺服器去 chat_messages 撈，
   而且只念**角色說的**（role='assistant'）——念使用者自己打的字沒有意義，
   卻等於開放了一個「你給我文字我念給你聽」的入口，那正是這條鐵則要擋的。

   為什麼閒聊也該有聲音：師兄的聲線在解卦那裡有、在閒聊裡沒有，等於同一個人
   在兩個地方是兩種存在。而閒聊才是人真正停留的地方。 */
export async function speakChat(
  db: SupabaseClient, uid: string, plan: string, messageId: unknown,
  doFetch: Fetch = fetch,
): Promise<TtsResult> {
  if (!API_KEY) return { ok: false, msg: "伺服器尚未設定語音金鑰" };
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, msg: "沒說要念哪一句" };

  const { data: msg } = await db.from("chat_messages")
    .select("id, user_id, character_id, role, body, created_at")
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!msg) return { ok: false, msg: "找不到這一句" };
  if ((msg as { role: string }).role !== "assistant")
    return { ok: false, msg: "只念得了角色說的話" };

  const row = msg as { character_id: string; body: string; created_at: string };

  // 副標帶的是「他當時說了什麼」——收藏清單上一排「大師兄・閒聊」分不出誰是誰，
  // 而人記得住的是自己問過什麼。取緊鄰在前的那一則使用者發言。
  const { data: askRows } = await db.from("chat_messages")
    .select("body, role").eq("user_id", uid).eq("character_id", row.character_id)
    .lt("id", id).order("id", { ascending: false }).limit(1);
  const asked = (askRows ?? [])[0] as { body: string; role: string } | undefined;

  const { data: ch } = await db.from("characters").select("name").eq("id", row.character_id).maybeSingle();
  const who = (ch as { name?: string } | null)?.name || "觀中人";

  return await speakSource(db, uid, plan, {
    source: row.body ?? "",
    charVoice: voiceOf(row.character_id),
    title: `${who}・閒聊`,
    subtitle: asked?.role === "user" ? asked.body : null,
    characterId: row.character_id,
  }, doFetch);
}

/* ── 合成一段原文 ───────────────────────────────────────────────
   批文與閒聊共用這一段。分開寫兩份的話，額度怎麼扣、快取怎麼查、
   text_hash 怎麼算就會慢慢走偏，而走偏的那天沒有人會發現——
   只會發現「同一句話在兩個地方收成了兩則」。 */
async function speakSource(
  db: SupabaseClient, uid: string, plan: string,
  o: { source: string; charVoice: string; title: string; subtitle: string | null; characterId: string | null },
  doFetch: Fetch,
): Promise<TtsResult> {
  // 分軌：角色說的話用角色的嗓子，＊…＊ 的旁白用旁白那把。
  // 段落順序原樣保留——parts 是一串照順序播的音檔，換嗓子不換次序。
  const charVoice = o.charVoice;
  const source = o.source;
  const pieces = piecesOf(source, charVoice);
  if (!pieces.length) return { ok: false, msg: "這一段沒有可念的字" };

  const store = db.storage.from(BUCKET);

  /* ── 先排好整篇要念哪些段、哪些還沒有檔 ──────────────────────
     額度**一次檢查整篇**，不是一段一段扣。
     一段一段扣的話，長批文會在中間某一段用完額度：前幾段已經合成、
     已經付錢、已經扣掉，然後整支回失敗，使用者一個字也沒聽到。
     花了錢又沒東西聽，是所有失敗方式裡最糟的一種。 */
  const plan_: (Piece & { path: string; miss: boolean })[] = [];
  let total = 0, need = 0;
  for (const p of pieces) {
    total += p.text.length;
    const path = `${await sha256(`${MODEL}|${p.voiceId}|${p.text}`)}.mp3`;
    const { data: hit } = await store.list("", { search: path, limit: 1 });
    const miss = !hit?.length;
    if (miss) need += p.text.length;       // 命中快取的不算——重聽不該吃額度
    plan_.push({ ...p, path, miss });
  }

  // 要合成的字一次扣完。need 為 0＝整篇都在快取裡，連問都不必問。
  if (need > 0) {
    const paid = await spendQuota(db, uid, plan, need);
    if (!paid.ok) return { ok: false, msg: paid.msg };
  }

  const parts: { url: string; path: string; text: string; chars: number; narrator: boolean }[] = [];
  let synthesized = 0;
  for (const p of plan_) {
    if (p.miss) {
      let bytes: Uint8Array;
      try { bytes = await synth(p.text, p.voiceId, doFetch); }
      catch (e) { return { ok: false, msg: String((e as Error).message ?? e) }; }
      const { error } = await store.upload(p.path, bytes, {
        contentType: "audio/mpeg", upsert: true, cacheControl: "31536000",
      });
      if (error) return { ok: false, msg: `音檔存不進去：${error.message}` };
      synthesized++;
    }
    // text 一起下發：語音頁點開要能把念的字攤出來，而那幾個字只有這裡知道
    // （客戶端從頭到尾沒有握過原文，它送的只是 cast_id）。
    parts.push({
      url: store.getPublicUrl(p.path).data.publicUrl, path: p.path,
      text: p.text, chars: p.text.length, narrator: p.narrator,
    });
  }

  return {
    ok: true,
    payload: {
      voice_id: charVoice, narrator_voice_id: VOICE_NARRATOR, model: MODEL,
      parts, chars: total, cached: synthesized === 0,
      // 每次朗讀都把額度現況帶回去：畫面上要說得出「本月還能請人念幾段」，
      // 而不是等到用完那一次才第一次讓人知道有這回事。
      quota: await ttsQuota(db, uid, plan),
      // 收藏用得上：同一段文字＋同一把嗓子＝同一則收藏，鍵由伺服器算。
      text_hash: await sha256(`${MODEL}|${charVoice}|${source}`),
      title: o.title, subtitle: o.subtitle,
      character_id: o.characterId,
    },
  };
}

/* ── 事後把逐字稿找回來 ─────────────────────────────────────────── */

/**
 * 這幾段音檔當初念的是哪些字。
 *
 * 為什麼需要：語音頁點下去要把念的字攤開來跟著跑，而 0047 之前收下的那些
 * 收藏只存了「哪幾個音檔、什麼順序」，沒存字。字並沒有不見——它算得回來，
 * 因為快取鍵就是由原文算的。
 *
 * 認法是**用 text_hash 對**：本體與每一則追問各算一次 `sha256(模型|聲線|原文)`，
 * 對上收藏存的那一個才算數。對不上就回 `null`——寧可畫面上沒有全文，
 * 也不要替這段聲音配上一段別的文字，那比沒有更糟。
 * （追問的序號沒有存進收藏，所以只能這樣認；而這樣認是精確的，不是猜的。）
 *
 * 不合成、不上傳、不扣額度：從頭到尾只有兩次查詢跟幾次雜湊。
 */
export async function castTexts(
  db: SupabaseClient, uid: string, castId: string, textHash: string,
): Promise<Piece[] | null> {
  if (!castId || !textHash) return null;

  const { data: cast } = await db.from("casts")
    .select("id, user_id, character_id, question, reading")
    .eq("id", castId).eq("user_id", uid).maybeSingle();
  if (!cast) return null;                    // 卦刪了：聲音還在，字回不來了

  const charVoice = voiceOf(cast.character_id);
  const sources = [bodySource(cast)];
  const { data: fups } = await db.from("followups")
    .select("question, answer").eq("cast_id", castId).order("created_at");
  for (const f of fups ?? []) sources.push(followupSource(f));

  for (const source of sources) {
    if (!source) continue;
    if (await sha256(`${MODEL}|${charVoice}|${source}`) !== textHash) continue;
    return piecesOf(source, charVoice);
  }
  return null;
}

/** 收藏清單上顯示的那一行。前端不自己組——組出來的字會跟伺服器的版本走偏。 */
function titleOf(cast: { gua_ben?: string | null }, part: "body" | number): string {
  const gua = cast.gua_ben ? `《${cast.gua_ben}》` : "解卦";
  return part === "body" || part == null ? gua : `${gua}・第 ${Number(part) + 1} 問`;
}
