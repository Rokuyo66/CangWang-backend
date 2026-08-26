// _shared/voice.ts — 收藏語音。
//
// 「收藏」的實質是：把已經合成好的音檔留下來，之後重聽不再呼叫 TTS。
//
// 【這一版把上傳整套拿掉了】
// 上一版要前端把 mp3 PUT 到一個私有的 voice bucket，再回頭 confirm。那個設計
// 有兩個問題，第二個是致命的：
//   一、tts bucket 的鍵是 sha256(模型|聲線|逐字文本)、cacheControl 一年，
//       音檔本來就永久留著了。再複製一份到另一個桶，是為同一段聲音付兩份儲存費。
//   二、前端手上根本沒有那個 mp3。reading-tts.js 拿到的是 tts bucket 的公開
//       網址，它從頭到尾沒有握過檔案。契約要的東西，那個畫面生不出來——
//       所以「收藏語音」那顆鈕做不出來，一直沒有被做出來。
// 現在收藏只是記一個指標：哪幾個音檔、照什麼順序播。零複製、零上傳。
//
// 【心跡不能全是付費產物，所以這裡刻意鬆】
//   ・收藏本身不扣朗讀額度、不扣靈石——它沒有產生任何新的合成。
//   ・收藏過的永遠能重聽：免費、無限次、額度用完了也能聽、玉牒到期了也還在。
//   ・PLAN_CLIPS 擋的是「再收新的」，不是「保留」與「重聽」。藏往收了 100 段
//     之後掉回無牒，那 100 段一段都不會消失，也不會被藏起來——那是他的東西。
// 免費帳號在語音頁永遠有東西可以聽，這一頁才不會變成一面上鎖的架子。
//
// 不 import tts.ts（它載入時就讀 MINIMAX_API_KEY 等環境變數，會讓這一層
// 離線測不動）。合成那一步由呼叫端注入，測試給替身即可。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type VoiceResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

const err = (msg: string): VoiceResult => ({ ok: false, msg });
const ok = (payload: Record<string, unknown>): VoiceResult => ({ ok: true, payload });

/** 收藏格數。免費 3 段足以讓人知道這件事存在，第四段就是付費點。 */
export const PLAN_CLIPS: Record<string, number> = { free: 3, guanwei: 10, zhiji: 30, cangwang: 100 };
export const clipQuotaOf = (plan: string) => PLAN_CLIPS[plan] ?? PLAN_CLIPS.free;

/** 一則收藏最多幾段音檔。長批文會被切段，20 段已經是十來分鐘的東西。 */
const MAX_PARTS = 20;

/** 合成一段並回報音檔位置。呼叫端把 tts.speakCast 包一層丟進來。 */
export type Speak = (castId: string, part: "body" | number) => Promise<VoiceResult>;

/** 收藏裡的一段音檔。url 是 tts bucket 的公開網址（鍵是內容雜湊，猜不到也列不出）。
 *  text 是這一段念的字：語音頁點下去要把它攤開來跟著跑，而客戶端手上沒有原文
 *  （它送的只是 cast_id），所以只能由這裡帶下去。0047 之前收的沒有這一欄，
 *  由 voiceList 補（見 backfillTexts）。 */
export interface ClipPart {
  url: string; path: string; chars: number; narrator: boolean; text?: string | null;
}

/** 把逐字稿找回來。實作在 tts.ts（`castTexts`），由呼叫端注入——
 *  這一層不 import tts.ts，見檔頭。回 null＝對不上，那一則就維持沒有全文。 */
export type Retell = (castId: string, textHash: string) =>
  Promise<{ text: string; narrator: boolean }[] | null>;

interface ClipRow {
  id: string; cast_id: string | null; character_id: string | null; kind: string;
  title: string; subtitle: string | null; parts: ClipPart[] | null;
  duration_ms: number | null; voice_id: string | null;
  text_hash: string; created_at: string;
}

const LIST_COLS =
  "id, cast_id, character_id, kind, title, subtitle, parts, duration_ms, voice_id, text_hash, created_at";

/* ═══════════════ 收 ═══════════════ */

/**
 * 收藏這一卦的這一段。
 *
 * 合成走的是與「朗讀」完全相同的那條路（speak 注入的就是 speakCast），所以：
 * 已經聽過的＝命中快取＝不花錢也不吃額度；沒聽過就按收藏＝合成一次，
 * 與按下朗讀是同一件事、同一個價錢。不另立一條規則——兩條路會走偏。
 *
 * 去重認的是伺服器算的 text_hash（模型＋聲線＋逐字文本）。同一段收兩次是
 * 同一則：不多佔一格，也不多存一份。
 */
export async function voiceKeep(
  db: SupabaseClient, uid: string, plan: string, speak: Speak,
  p: { cast_id?: unknown; part?: unknown; kind?: unknown },
): Promise<VoiceResult> {
  const castId = String(p.cast_id ?? "").trim();
  if (!castId) return err("沒說要收哪一卦");

  // part：body（批文本體）或數字（第幾則追問）。形狀與 tts 模式一致。
  const rawPart = p.part;
  const part: "body" | number =
    rawPart == null || rawPart === "body" ? "body" : Number(rawPart);
  if (part !== "body" && !Number.isInteger(part)) return err("不知道要收哪一段");

  const r = await speak(castId, part);
  if (!r.ok) return r;                       // 額度不足、找不到卦等，原話帶回去

  const payload = r.payload as {
    parts?: ClipPart[]; text_hash?: string; title?: string; subtitle?: string | null;
    character_id?: string | null; voice_id?: string | null; quota?: unknown;
  };
  const parts = (payload.parts ?? []).filter((x) => x && x.url && x.path).slice(0, MAX_PARTS)
    .map((x) => ({
      url: x.url, path: x.path, chars: Number(x.chars) || 0, narrator: !!x.narrator,
      text: x.text ? String(x.text) : null,
    }));
  const hash = String(payload.text_hash ?? "").trim().slice(0, 64);
  if (!parts.length) return err("這一段沒有可以收的聲音");
  if (!hash) return err("缺內容指紋");

  // 已經收過 → 回原本那一則。不佔第二格，也不算失敗。
  const { data: dup } = await db.from("voice_clips").select(LIST_COLS)
    .eq("user_id", uid).eq("text_hash", hash).maybeSingle();
  if (dup) {
    return ok({
      clip: view(dup as ClipRow), duplicate: true,
      quota: await countQuota(db, uid, plan), tts_quota: payload.quota ?? null,
    });
  }

  // 額度只擋「再收新的」。既有的不動、不藏、不刪——見檔頭。
  const q = await countQuota(db, uid, plan);
  if (q.used >= q.max) {
    return err(q.max === PLAN_CLIPS.free
      ? `語音收藏滿了（${q.max} 段）。要收新的，得先捨棄一段——或持玉牒入觀，多幾格。`
      : `語音收藏滿了（${q.max} 段）。先捨棄一段，再收新的。`);
  }

  const { data: row, error } = await db.from("voice_clips").insert({
    user_id: uid,
    cast_id: castId,
    character_id: payload.character_id ?? null,
    kind: String(p.kind ?? (part === "body" ? "reading" : "followup")).slice(0, 16),
    title: String(payload.title ?? "解卦").slice(0, 60),
    subtitle: payload.subtitle ? String(payload.subtitle).slice(0, 80) : null,
    parts,
    duration_ms: estimateMs(parts),
    voice_id: payload.voice_id ?? null,
    text_hash: hash,
  }).select(LIST_COLS).single();

  if (error) {
    // unique(user_id, text_hash) 撞到＝同一瞬間按了兩次。那不是錯誤，
    // 是同一則——把既有那一列撈回來給他，畫面上就是「已在收藏裡」。
    const { data: again } = await db.from("voice_clips").select(LIST_COLS)
      .eq("user_id", uid).eq("text_hash", hash).maybeSingle();
    if (again) {
      return ok({
        clip: view(again as ClipRow), duplicate: true,
        quota: await countQuota(db, uid, plan), tts_quota: payload.quota ?? null,
      });
    }
    console.error("voiceKeep insert failed", error);
    return err("收不下來，稍後再試");
  }

  return ok({
    clip: view(row as ClipRow), duplicate: false,
    quota: await countQuota(db, uid, plan), tts_quota: payload.quota ?? null,
  });
}

/* ═══════════════ 聽、丟 ═══════════════ */

/** 收藏清單。網址直接下發：tts bucket 是公開的，鍵是內容的 SHA-256，
 *  猜不到也列不出（bucket 不開 list 權限）。用簽名網址反而會讓 CDN 快取失效，
 *  等於每次重播都重新下載一份——把「快取」這件事做掉一半。 */
export async function voiceList(
  db: SupabaseClient, uid: string, plan: string, retell?: Retell,
): Promise<VoiceResult> {
  const { data } = await db.from("voice_clips").select(LIST_COLS)
    .eq("user_id", uid)
    .order("created_at", { ascending: false }).limit(120);
  const rows = (data ?? []) as ClipRow[];
  if (retell) await backfillTexts(db, uid, rows, retell);
  return ok({ clips: rows.map(view), quota: quotaOf(rows.length, plan) });
}

/** 舊收藏補逐字稿。0047 之前收的只有音檔位置，沒有字——語音頁要「點開展開全文」
 *  就少了字。字算得回來（快取鍵就是由原文算的），所以在清單這裡順手補，
 *  補完寫回去，下一次就不必再算。
 *
 *  一次最多補幾則：補一則是兩次查詢，一百二十則全補會讓這一頁變慢，
 *  而人一次也看不完一百二十則。剩下的下次開這一頁再補，自己會補完。
 *
 *  段數對不上就整則放棄：切法調過（TTS_CHUNK_CHARS）或那一卦被改過都會這樣。
 *  這種時候寧可留白——把甲段的字配在乙段的聲音上，比沒有字更糟。
 *
 *  補不回來的那幾則（多半是那一卦已經刪了）每次開這一頁都會再試一次。
 *  代價是幾次查詢，上限就是 BACKFILL_PER_LIST；換來的是「哪天卦又回來了
 *  （還原備份、改了切法）字就自己補上」，不必記得去跑什麼。 */
const BACKFILL_PER_LIST = 12;
async function backfillTexts(
  db: SupabaseClient, uid: string, rows: ClipRow[], retell: Retell,
): Promise<void> {
  let budget = BACKFILL_PER_LIST;
  for (const r of rows) {
    if (budget <= 0) break;
    const parts = r.parts ?? [];
    if (!parts.length || parts.every((x) => x.text)) continue;
    if (!r.cast_id) continue;
    budget--;

    let said: { text: string; narrator: boolean }[] | null = null;
    try { said = await retell(r.cast_id, r.text_hash); }
    catch (e) { console.error("voice backfill failed", e); continue; }
    if (!said || said.length !== parts.length) continue;

    const merged = parts.map((x, i) => ({ ...x, text: said![i].text }));
    r.parts = merged;                        // 這一次的回應就已經有字了
    await db.from("voice_clips").update({ parts: merged })
      .eq("id", r.id).eq("user_id", uid);
  }
}

/** 丟掉一則收藏。**不刪音檔**——那個檔在 tts bucket 裡是全站共用的快取，
 *  別的收藏、別的人的重聽都可能指著它。刪了它等於替別人也刪了一次，
 *  而且下次有人念同一段就得重新付錢合成。這裡刪的只是「我收著」這件事。 */
export async function voiceDelete(
  db: SupabaseClient, uid: string, clipId: unknown,
): Promise<VoiceResult> {
  const id = String(clipId ?? "");
  const { data: c } = await db.from("voice_clips").select("id")
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!c) return err("查無這一段");
  await db.from("voice_clips").delete().eq("id", id).eq("user_id", uid);
  return ok({ id, deleted: true });
}

/* ═══════════════ 內部 ═══════════════ */

/** 長度是**估的**：字數 ÷ 每秒字數。真值要下載整個 mp3 解檔頭才知道，
 *  而為了在清單上顯示一個「2:14」去下載幾 MB 的音檔並不划算。
 *  中文朗讀約每秒 4.5 字（MiniMax 預設語速實測的量級）。估得不準的代價
 *  是清單上的秒數差幾秒，沒有人會因此做錯決定。 */
const CHARS_PER_SEC = 4.5;
const msOf = (chars: number) => Math.round((Math.max(0, chars) / CHARS_PER_SEC) * 1000);

/** 全長＝各段長度之和，不是「總字數換算一次」。差的是幾毫秒的進位，
 *  但進度條是一段一段接著跑的：兩邊各算各的，跑到最後一段就會對不上，
 *  出現「條滿了、秒數還剩兩秒」。 */
function estimateMs(parts: ClipPart[]): number | null {
  const ms = parts.reduce((n, p) => n + msOf(Number(p.chars) || 0), 0);
  return ms > 0 ? ms : null;
}

/** 波形是**畫的，不是量的**：由內容指紋展開成一串固定的高度（0..100）。
 *
 *  真波形要把整個 mp3 抓下來解碼才畫得出來，為了一排裝飾條下載幾 MB 不划算
 *  （長度那個「2:14」也是同一個理由用估的）。而純亂數的話，同一則收藏每次
 *  打開都長不一樣，看起來像壞掉——由指紋展開就是每則各有各的樣子、每次都一樣。
 *
 *  ⚠ 這串數字不代表音量，不要拿它做任何分析或顯示成「音量」。
 *  它的用途只有一個：讓進度看起來像一段聲音，而不是一條灰色的長條。
 *  前端若想要真的跟著聲音跳，接 WebAudio 的 analyser 疊在上面即可——
 *  那是純前端的事，不影響這串保底的形狀。 */
const BARS = 44;
export function peaksOf(hash: string): number[] {
  const h = String(hash ?? "");
  if (h.length < 8) return [];
  let s = parseInt(h.slice(0, 8), 16) >>> 0 || 1;
  const phase = (parseInt(h.slice(8, 10), 16) || 0) / 255 * Math.PI * 2;
  const out: number[] = [];
  for (let i = 0; i < BARS; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;               // LCG，夠亂也夠穩
    const jitter = s / 4294967296;                       // 0..1
    // 一條慢的包絡：說話有起伏，白噪音沒有。少了它整排會像等高的柵欄。
    const env = 0.5 + 0.5 * Math.sin(phase + (i / BARS) * Math.PI * 2.7);
    const v = (0.30 + 0.70 * jitter) * (0.45 + 0.55 * env);
    out.push(Math.max(14, Math.min(100, Math.round(v * 100))));
  }
  return out;
}

/** 格數現況。used 可能大於 max（收滿之後玉牒到期），那是允許的狀態：
 *  舊的留著，只是收不了新的。前端照這個形狀顯示「10 / 3」不必特別處理。 */
function quotaOf(used: number, plan: string) {
  const max = clipQuotaOf(plan);
  return { used, max, can_add: used < max };
}

async function countQuota(db: SupabaseClient, uid: string, plan: string) {
  const { count } = await db.from("voice_clips").select("id", { count: "exact", head: true })
    .eq("user_id", uid);
  return quotaOf(count ?? 0, plan);
}

/** 下發用的形狀。storage 路徑不下發——那是伺服器內部的位置。
 *
 *  parts 帶的是播一遍要用的全部東西：照順序的音檔、那一段念的字、誰念的、
 *  這一段大約多長。播放器要能做到「點下去→展開全文→進度跟著跑→剩幾秒」，
 *  少任何一樣都得由前端去猜，而它猜不出來（它手上沒有原文）。
 *
 *  duration_ms 一律照 parts 現算，不用資料庫那一欄：那一欄是收下來那天算的，
 *  往後若換了估法，清單上的秒數會與進度條的總長不一致。 */
const view = (r: ClipRow) => {
  const parts = (r.parts ?? []).map((x) => ({
    url: x.url,
    text: x.text ?? null,
    narrator: !!x.narrator,
    ms: msOf(Number(x.chars) || 0),
  }));
  return {
    id: r.id, cast_id: r.cast_id, character_id: r.character_id, kind: r.kind,
    title: r.title, subtitle: r.subtitle,
    duration_ms: parts.reduce((n, x) => n + x.ms, 0) || r.duration_ms,
    peaks: peaksOf(r.text_hash),
    voice_id: r.voice_id, created_at: r.created_at,
    parts,
  };
};
