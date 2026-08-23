// _shared/events.ts — 道緣事件的伺服端服務層。
//
// 事件的內容（章名、摘要、每一幕的台詞）本來寫死在前端的 src/story/mock-events.js，
// 而 0037 建 character_events 時就已經備好 scenes 欄位——只是沒人把它吐出來。
// 結果「改一句台詞」等於改前端、重新打包、要使用者更新 App。
// 這一層把內容交還給資料庫：改劇本是改一列資料，不是出一版。
//
// 兩支 API 分得很開，理由是「清單」與「內容」該在不同時機下發：
//   listEvents  只給目錄（章名、摘要、幾幕、門檻），不含任何一句台詞。
//   openEvent   才給那一章的 scenes，而且門檻在這裡才真正驗——
//               清單上畫成「道緣 300 可啟」是給人看的，擋不住直接打 API 的人。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type EventResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

interface EventRow {
  id: string; character_id: string; chapter: number; seq: number;
  title: string; summary: string | null;
  require_favor: number; require_event: string | null;
  scenes: unknown[]; choices: unknown[] | null;
}

const LIST_COLS =
  "id, character_id, chapter, seq, title, summary, require_favor, require_event, scenes, choices";

/** 目錄：一角色一串，依 chapter／seq。
 *
 *  scenes 只回幾幕、不回內容——清單頁一次要畫全部的章，把每一章的台詞都送下去，
 *  等於開啟事件之前就把整條線劇透完，而且多數章玩家當下根本不會點。
 *  前端判斷「章已規劃、內容還沒寫」用的是 scene_count === 0，與原本讀
 *  ev.scenes.length 等價。 */
const briefOf = (r: EventRow) => ({
  id: r.id, chapter: r.chapter, seq: r.seq,
  title: r.title, summary: r.summary ?? "",
  require_favor: r.require_favor, require_event: r.require_event,
  scene_count: Array.isArray(r.scenes) ? r.scenes.length : 0,
  has_choices: Array.isArray(r.choices) && r.choices.length > 0,
});

/** 撈目錄。characterId 省略＝全部角色，回一份 { cid: [...] }。
 *
 *  會有「全部」這個模式，是因為道緣卡片上那顆「事件」鈕要當場決定亮不亮
 *  （這角色有沒有章），三個角色各打一次網路只為了三顆鈕的狀態太蠢。 */
export async function listEvents(
  db: SupabaseClient, characterId?: unknown,
): Promise<EventResult> {
  const cid = characterId == null ? null : String(characterId);
  if (cid === "") return { ok: false, msg: "缺角色" };
  let q = db.from("character_events").select(LIST_COLS).eq("published", true);
  if (cid) q = q.eq("character_id", cid);
  const { data, error } = await q
    .order("chapter", { ascending: true }).order("seq", { ascending: true });
  if (error) { console.error("event_list failed", error); return { ok: false, msg: "事件讀不回來" }; }
  const rows = (data ?? []) as EventRow[];
  if (cid) return { ok: true, payload: { character_id: cid, events: rows.map(briefOf) } };
  const byChar: Record<string, ReturnType<typeof briefOf>[]> = {};
  for (const r of rows) (byChar[r.character_id] ??= []).push(briefOf(r));
  return { ok: true, payload: { catalog: byChar } };
}

/** 開一章：門檻在這裡驗，過了才給 scenes。
 *
 *  三道門，順序就是玩家會遇到的順序，訊息也照這個順序給——
 *  一次只講一件事，比「條件不足」有用。 */
export async function openEvent(
  db: SupabaseClient, uid: string, eventId: unknown,
): Promise<EventResult> {
  const id = String(eventId ?? "");
  const { data: ev } = await db.from("character_events")
    .select(LIST_COLS + ", published").eq("id", id).maybeSingle();
  if (!ev || !(ev as { published: boolean }).published) return { ok: false, msg: "查無此章" };
  const e = ev as EventRow;

  if (!Array.isArray(e.scenes) || !e.scenes.length) return { ok: false, msg: "此章尚未開放" };

  if (e.require_event) {
    const { data: prev } = await db.from("user_character_events").select("completed_at")
      .eq("user_id", uid).eq("event_id", e.require_event).maybeSingle();
    if (!(prev as { completed_at: string | null } | null)?.completed_at)
      return { ok: false, msg: "前一章尚未了結" };
  }

  if (e.require_favor > 0) {
    const { data: uc } = await db.from("user_character").select("favor")
      .eq("user_id", uid).eq("character_id", e.character_id).maybeSingle();
    if (((uc as { favor: number } | null)?.favor ?? 0) < e.require_favor)
      return { ok: false, msg: "道緣未至" };
  }

  // rewards 不下發：那是結案時由 event_finish 判定並發放的，
  // 提早送下去只會讓人知道走完有什麼，還讓客戶端有東西可以拿來對帳。
  return {
    ok: true,
    payload: {
      event: {
        id: e.id, character_id: e.character_id, chapter: e.chapter,
        title: e.title, summary: e.summary ?? "",
        scenes: e.scenes, choices: e.choices ?? null,
      },
    },
  };
}
