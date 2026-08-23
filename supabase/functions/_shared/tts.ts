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
// 每人每日合成字數上限。命中快取不算——重聽不該吃額度。
const DAILY_CHARS = Number(Deno.env.get("TTS_CHARS_PER_DAY") ?? "12000");
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

/* ── 額度 ───────────────────────────────────────────────────────── */
async function spendQuota(db: SupabaseClient, uid: string, chars: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("tts_usage").select("chars")
    .eq("user_id", uid).eq("day", day).maybeSingle();
  const used = Number(data?.chars ?? 0);
  if (used + chars > DAILY_CHARS) return false;
  await db.from("tts_usage").upsert(
    { user_id: uid, day, chars: used + chars },
    { onConflict: "user_id,day" },
  );
  return true;
}

/* ── 對外：念某一卦的某一段 ─────────────────────────────────────── */
export async function speakCast(
  db: SupabaseClient,
  uid: string,
  castId: string,
  part: "body" | number,
  doFetch: Fetch = fetch,
): Promise<TtsResult> {
  if (!API_KEY) return { ok: false, msg: "伺服器尚未設定語音金鑰" };
  if (!castId) return { ok: false, msg: "沒說要念哪一卦" };

  const { data: cast } = await db.from("casts")
    .select("id, user_id, character_id, question, reading")
    .eq("id", castId).eq("user_id", uid).maybeSingle();
  if (!cast) return { ok: false, msg: "找不到這一卦" };

  // 念什麼一律伺服器決定：body＝提問＋批文，數字＝第幾則追問的一問一答
  let source = "";
  if (part === "body" || part == null) {
    source = [cast.question ? `所問：${cast.question}。` : "", cast.reading ?? ""]
      .filter(Boolean).join("\n");
  } else {
    const { data: fups } = await db.from("followups")
      .select("question, answer").eq("cast_id", castId).order("created_at");
    const f = (fups ?? [])[Number(part)];
    if (!f) return { ok: false, msg: "沒有這一則追問" };
    source = [`所問：${f.question}。`, f.answer].filter(Boolean).join("\n");
  }

  // 分軌：角色說的話用角色的嗓子，＊…＊ 的旁白用旁白那把。
  // 段落順序原樣保留——parts 是一串照順序播的音檔，換嗓子不換次序。
  const segs = segments(source);
  if (!segs.length) return { ok: false, msg: "這一段沒有可念的字" };

  const charVoice = voiceOf(cast.character_id);
  const store = db.storage.from(BUCKET);
  const parts: { url: string; chars: number; narrator: boolean }[] = [];
  let synthesized = 0, total = 0;

  for (const seg of segs) {
    const voiceId = seg.narrator ? VOICE_NARRATOR : charVoice;
    for (const piece of chunk(seg.text)) {
      total += piece.length;
      const key = await sha256(`${MODEL}|${voiceId}|${piece}`);
      const path = `${key}.mp3`;
      const { data: hit } = await store.list("", { search: path, limit: 1 });
      if (!hit?.length) {
        // 額度只在真的要合成時才扣——重聽命中快取不該算在使用者頭上
        if (!await spendQuota(db, uid, piece.length)) {
          return { ok: false, msg: "今天的語音額度用完了，明天再來" };
        }
        let bytes: Uint8Array;
        try { bytes = await synth(piece, voiceId, doFetch); }
        catch (e) { return { ok: false, msg: String((e as Error).message ?? e) }; }
        const { error } = await store.upload(path, bytes, {
          contentType: "audio/mpeg", upsert: true, cacheControl: "31536000",
        });
        if (error) return { ok: false, msg: `音檔存不進去：${error.message}` };
        synthesized++;
      }
      parts.push({
        url: store.getPublicUrl(path).data.publicUrl,
        chars: piece.length, narrator: seg.narrator,
      });
    }
  }

  return {
    ok: true,
    payload: {
      voice_id: charVoice, narrator_voice_id: VOICE_NARRATOR, model: MODEL,
      parts, chars: total, cached: synthesized === 0,
    },
  };
}
