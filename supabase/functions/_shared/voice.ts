// _shared/voice.ts — 收藏語音。
//
// 「收藏」的實質是：把已經合成好的音檔留下來，之後重聽不再呼叫 TTS。
// 所以語音頁播放幾百次都是零邊際成本，而它同時是留存（想再聽一次師兄那句話）
// 與訂閱誘因。撐住它的是儲存費不是 AI 費——儲存費可預期，AI 費不可。
//
// 【上傳為什麼分兩步】音檔一兩 MB。把 base64 塞進 Edge Function 的 JSON body，
// 等於每收藏一次就讓那支函式扛一份三 MB 的字串進記憶體再吐出去，而它同時還在
// 服務起卦。改成：voiceSave 先查額度、開一張簽名上傳網址，前端直接 PUT 到
// Storage，回頭 voiceConfirm。額度在上傳「之前」就擋掉，不會發生
// 「傳了兩 MB 才被告知超額」。
//
// 不 import services.ts（載入時讀 Deno.env），整層離線測得動；
// Storage 的三個動作由呼叫端注入，測試給替身即可。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type VoiceResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

const err = (msg: string): VoiceResult => ({ ok: false, msg });
const ok = (payload: Record<string, unknown>): VoiceResult => ({ ok: true, payload });

/** 收藏格數。免費 3 段足以讓人知道這件事存在，第四段就是付費點。 */
export const PLAN_CLIPS: Record<string, number> = { free: 3, guanwei: 10, zhiji: 30, cangwang: 100 };
export const clipQuotaOf = (plan: string) => PLAN_CLIPS[plan] ?? PLAN_CLIPS.free;

/** 單檔上限。一段批文朗讀約一到三分鐘、mp3 約 0.5～1.5 MB；6 MB 是很寬的天花板，
 *  它擋的不是正常使用，是「拿這個 bucket 當免費網路硬碟」。 */
export const MAX_CLIP_BYTES = 6 * 1024 * 1024;

export const BUCKET = "voice";

/** Storage 的三個動作。呼叫端用真的 supabase storage client 包一層丟進來。 */
export interface VoiceStore {
  signUpload(path: string): Promise<{ url: string; token: string } | null>;
  signDownload(path: string, seconds: number): Promise<string | null>;
  exists(path: string): Promise<{ bytes: number } | null>;
  remove(path: string): Promise<void>;
}

interface ClipRow {
  id: string; cast_id: string | null; character_id: string | null; kind: string;
  title: string; subtitle: string | null; storage_path: string;
  duration_ms: number | null; bytes: number | null; voice_id: string | null;
  text_hash: string; ready: boolean; created_at: string;
}

const LIST_COLS =
  "id, cast_id, character_id, kind, title, subtitle, storage_path, duration_ms, bytes, voice_id, text_hash, ready, created_at";

/* ═══════════════ 收 ═══════════════ */

/**
 * 開始收藏：查額度、去重、建一列 ready=false，回一張簽名上傳網址。
 *
 * 去重是認「同一段文字＋同一把嗓子」（text_hash 由前端算，內容是
 * 朗讀的原文 ＋ voice_id）。同一段話收兩次是同一則，既不該多佔一格，
 * 也不該多存一份檔案——直接把既有那一則回去，前端顯示「已在收藏裡」。
 */
export async function voiceSave(
  db: SupabaseClient, uid: string, plan: string, store: VoiceStore,
  p: {
    cast_id?: unknown; character_id?: unknown; kind?: unknown;
    title?: unknown; subtitle?: unknown; duration_ms?: unknown;
    bytes?: unknown; voice_id?: unknown; text_hash?: unknown;
  },
): Promise<VoiceResult> {
  const title = String(p.title ?? "").trim().slice(0, 60);
  const hash = String(p.text_hash ?? "").trim().slice(0, 64);
  if (!title) return err("這一段沒有標題，存不下來");
  if (!hash) return err("缺內容指紋");

  const bytes = Number(p.bytes ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return err("音檔大小不明");
  if (bytes > MAX_CLIP_BYTES)
    return err(`這一段太長了（上限 ${Math.round(MAX_CLIP_BYTES / 1024 / 1024)} MB）`);

  // 已經收過同一段 → 回原本那一則，不佔第二格
  const { data: dup } = await db.from("voice_clips").select(LIST_COLS)
    .eq("user_id", uid).eq("text_hash", hash).maybeSingle();
  if (dup) {
    const row = dup as ClipRow;
    if (row.ready) return ok({ clip: view(row), duplicate: true, upload: null });
    // 上次收到一半沒傳完 → 重開一張上傳網址讓它續完，不另建一列
    const up = await store.signUpload(row.storage_path);
    if (!up) return err("上傳網址開不出來，稍後再試");
    return ok({ clip: view(row), duplicate: true, upload: { ...up, path: row.storage_path } });
  }

  const max = clipQuotaOf(plan);
  const { count } = await db.from("voice_clips").select("id", { count: "exact", head: true })
    .eq("user_id", uid).eq("ready", true);
  if ((count ?? 0) >= max) {
    return err(max === PLAN_CLIPS.free
      ? `語音收藏滿了（${max} 段）。要收新的，得先捨棄一段——或持玉牒入觀，多幾格。`
      : `語音收藏滿了（${max} 段）。先捨棄一段，再收新的。`);
  }

  const { data: row, error } = await db.from("voice_clips").insert({
    user_id: uid,
    cast_id: p.cast_id ? String(p.cast_id) : null,
    character_id: p.character_id ? String(p.character_id) : null,
    kind: String(p.kind ?? "reading").slice(0, 16),
    title, subtitle: p.subtitle ? String(p.subtitle).slice(0, 80) : null,
    storage_path: "pending",          // 拿到 id 才組得出路徑，下一行補
    duration_ms: Number(p.duration_ms) || null,
    bytes, voice_id: p.voice_id ? String(p.voice_id) : null,
    text_hash: hash, ready: false,
  }).select(LIST_COLS).single();
  if (error) { console.error("voiceSave insert failed", error); return err("收不下來，稍後再試"); }

  const clip = row as ClipRow;
  const path = `${uid}/${clip.id}.mp3`;
  await db.from("voice_clips").update({ storage_path: path }).eq("id", clip.id);
  clip.storage_path = path;

  const up = await store.signUpload(path);
  if (!up) {
    // 開不出上傳網址就把佔位那一列收回去，不要留一則永遠 ready=false 的殭屍
    await db.from("voice_clips").delete().eq("id", clip.id);
    return err("上傳網址開不出來，稍後再試");
  }
  return ok({ clip: view(clip), duplicate: false, upload: { ...up, path } });
}

/** 上傳完了。**以 Storage 的實況為準**，不信前端說「我傳好了」——
 *  信它的話，一則點下去沒聲音的收藏會佔著格子，而人只會覺得這功能壞了。 */
export async function voiceConfirm(
  db: SupabaseClient, uid: string, store: VoiceStore, clipId: unknown,
): Promise<VoiceResult> {
  const id = String(clipId ?? "");
  const { data: c } = await db.from("voice_clips").select(LIST_COLS)
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!c) return err("查無這一段");
  const clip = c as ClipRow;
  if (clip.ready) return ok({ clip: view(clip) });

  const stat = await store.exists(clip.storage_path);
  if (!stat) return err("音檔還沒上傳完");
  if (stat.bytes > MAX_CLIP_BYTES) {
    await store.remove(clip.storage_path);
    await db.from("voice_clips").delete().eq("id", clip.id);
    return err("音檔超過上限，已丟棄");
  }

  const { data: out } = await db.from("voice_clips")
    .update({ ready: true, bytes: stat.bytes }).eq("id", clip.id).select(LIST_COLS);
  return ok({ clip: view(((out ?? [])[0] ?? clip) as ClipRow) });
}

/* ═══════════════ 聽、丟 ═══════════════ */

/** 收藏清單。播放網址是短效簽名的——bucket 是私有的，
 *  給永久網址等於把它變成公開的，而那些是付費用戶的東西。 */
export async function voiceList(
  db: SupabaseClient, uid: string, plan: string, store: VoiceStore,
): Promise<VoiceResult> {
  const { data } = await db.from("voice_clips").select(LIST_COLS)
    .eq("user_id", uid).eq("ready", true)
    .order("created_at", { ascending: false }).limit(120);
  const rows = (data ?? []) as ClipRow[];
  const clips = [];
  for (const r of rows) {
    clips.push({ ...view(r), url: await store.signDownload(r.storage_path, 3600) });
  }
  return ok({ clips, quota: { used: rows.length, max: clipQuotaOf(plan) } });
}

export async function voiceDelete(
  db: SupabaseClient, uid: string, store: VoiceStore, clipId: unknown,
): Promise<VoiceResult> {
  const id = String(clipId ?? "");
  const { data: c } = await db.from("voice_clips").select("id, storage_path")
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!c) return err("查無這一段");
  // 先刪檔再刪列。反過來的話，列沒了就再也找不到那個檔，bucket 會慢慢長出
  // 一堆沒有主人的音訊，而且沒有任何線索指出它們屬於誰。
  await store.remove((c as { storage_path: string }).storage_path);
  await db.from("voice_clips").delete().eq("id", id).eq("user_id", uid);
  return ok({ id, deleted: true });
}

/** 下發用的形狀。storage_path 不下發——那是伺服器內部的位置，
 *  給了它等於邀請人去猜別人的路徑。 */
const view = (r: ClipRow) => ({
  id: r.id, cast_id: r.cast_id, character_id: r.character_id, kind: r.kind,
  title: r.title, subtitle: r.subtitle, duration_ms: r.duration_ms,
  bytes: r.bytes, voice_id: r.voice_id, ready: r.ready, created_at: r.created_at,
});
