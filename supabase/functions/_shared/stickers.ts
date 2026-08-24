// _shared/stickers.ts — 貼紙：讓版面不要做死。
//
// 零 AI，純毛利。和 0030 那批配色同一類，但比配色好賣——配色一個帳號只買一次，
// 貼紙是包、可以一直出新的，而且人是在「想貼」的那一刻掏錢，
// 不是在商店頁被推銷的時候。所以價錢寫在抽屜裡，不另跳商店頁。
//
// 不 import services.ts（那支載入時就讀 Deno.env），整層離線測得動；
// 扣靈石由呼叫端注入一支 charge，同 xinji.ts 的 PrefaceGen。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type StickerResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

const err = (msg: string): StickerResult => ({ ok: false, msg });
const ok = (payload: Record<string, unknown>): StickerResult => ({ ok: true, payload });

/** 一頁最多貼幾張。不是為了省儲存（一列幾十位元組），是為了頁面還讀得下去——
 *  貼到看不見字的那一頁，隔天他自己會後悔，而後悔的對象會是這個功能。 */
export const MAX_PER_SURFACE = 24;

const ANCHORS = new Set(["page", "thread", "cast", "note"]);

/** surface 的合法形狀：timeline / voice / thread:<id> / month:YYYY-MM */
function validSurface(s: unknown): string | null {
  const v = String(s ?? "");
  if (v === "timeline" || v === "voice") return v;
  if (/^thread:[0-9a-f-]{36}$/i.test(v)) return v;
  if (/^month:\d{4}-\d{2}$/.test(v)) return v;
  return null;
}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

/* ═══════════════ 抽屜 ═══════════════ */

/** 貼紙口袋：已擁有的在前，未購的直接標價。
 *  未購包的貼紙一樣下發（要畫成鎖著的縮圖），但 asset 之外不多給——
 *  反正圖本來就在前端 bundle 裡，藏它沒有意義，藏的是「能不能貼」。 */
export async function stickerShelf(db: SupabaseClient, uid: string): Promise<StickerResult> {
  const { data: packRows, error } = await db.from("sticker_packs")
    .select("id, name, blurb, price, sort").eq("active", true).order("sort", { ascending: true });
  if (error) { console.error("stickerShelf packs failed", error); return err("貼紙口袋打不開"); }
  const packs = (packRows ?? []) as { id: string; name: string; blurb: string | null; price: number; sort: number }[];

  const { data: stRows } = await db.from("stickers")
    .select("id, pack_id, name, asset, sort").order("sort", { ascending: true });
  const stickers = (stRows ?? []) as { id: string; pack_id: string; name: string; asset: string }[];

  const { data: ownRows } = await db.from("owned_packs").select("pack_id").eq("user_id", uid);
  const owned = new Set((ownRows ?? []).map((r) => (r as { pack_id: string }).pack_id));
  // 免費包視同已有，不必真的寫一列——寫了就得在註冊流程補一段，
  // 而那段一旦漏跑，舊帳號就永遠少一包，且不會有人發現。
  for (const p of packs) if (p.price === 0) owned.add(p.id);

  return ok({
    packs: packs
      .map((p) => ({
        ...p, owned: owned.has(p.id),
        stickers: stickers.filter((s) => s.pack_id === p.id).map((s) => ({ id: s.id, name: s.name, asset: s.asset })),
      }))
      // 已擁有的排前面，其餘照 sort
      .sort((a, b) => (a.owned === b.owned ? a.sort - b.sort : a.owned ? -1 : 1)),
    max_per_surface: MAX_PER_SURFACE,
  });
}

/** 買一包。charge 由呼叫端注入（扣不動時 throw 或回 false）。 */
export async function buyPack(
  db: SupabaseClient, uid: string, packId: unknown,
  charge: (price: number, packId: string) => Promise<boolean>,
): Promise<StickerResult> {
  const id = String(packId ?? "");
  const { data: p } = await db.from("sticker_packs")
    .select("id, name, price, active").eq("id", id).maybeSingle();
  if (!p || !(p as { active: boolean }).active) return err("查無此貼紙包");
  const pack = p as { id: string; name: string; price: number };
  if (pack.price === 0) return err("這一包本來就是你的");

  const { data: had } = await db.from("owned_packs")
    .select("pack_id").eq("user_id", uid).eq("pack_id", id).maybeSingle();
  if (had) return err("這一包已經在你口袋裡了");

  // 先扣錢再給包。反過來的話，扣款失敗那一刻包已經送出去了。
  if (!await charge(pack.price, pack.id)) return err(`靈石不足，這一包需 ${pack.price} 顆`);

  const { error } = await db.from("owned_packs").insert({ user_id: uid, pack_id: id });
  if (error) {
    // 唯一鍵撞到＝兩台裝置同時買。錢只扣了一次（上面查過），這裡當作成功。
    if ((error as { code?: string }).code !== "23505") {
      console.error("buyPack insert failed", error);
      return err("入袋失敗，靈石未動");   // charge 那一步若真的扣了，由對帳補
    }
  }
  return ok({ pack_id: id, name: pack.name, paid: pack.price });
}

/* ═══════════════ 貼、移、撕 ═══════════════ */

async function ownsSticker(db: SupabaseClient, uid: string, stickerId: string) {
  const { data: s } = await db.from("stickers").select("id, pack_id").eq("id", stickerId).maybeSingle();
  if (!s) return null;
  const packId = (s as { pack_id: string }).pack_id;
  const { data: p } = await db.from("sticker_packs").select("price, active").eq("id", packId).maybeSingle();
  if (!p || !(p as { active: boolean }).active) return null;
  if ((p as { price: number }).price === 0) return packId;
  const { data: own } = await db.from("owned_packs")
    .select("pack_id").eq("user_id", uid).eq("pack_id", packId).maybeSingle();
  return own ? packId : null;
}

export async function placeSticker(
  db: SupabaseClient, uid: string,
  p: { surface?: unknown; sticker_id?: unknown; anchor?: unknown; anchor_id?: unknown;
       x?: unknown; y?: unknown; rot?: unknown; scale?: unknown },
): Promise<StickerResult> {
  const surface = validSurface(p.surface);
  if (!surface) return err("貼不到那一頁");
  const stickerId = String(p.sticker_id ?? "");
  if (!await ownsSticker(db, uid, stickerId)) return err("這張貼紙還不是你的");

  const anchor = ANCHORS.has(String(p.anchor ?? "page")) ? String(p.anchor ?? "page") : "page";
  const anchorId = anchor === "page" ? null : String(p.anchor_id ?? "");
  if (anchor !== "page" && !anchorId) return err("缺錨點");

  const { count } = await db.from("placed_stickers").select("id", { count: "exact", head: true })
    .eq("user_id", uid).eq("surface", surface);
  if ((count ?? 0) >= MAX_PER_SURFACE)
    return err(`這一頁已經貼了 ${MAX_PER_SURFACE} 張，再貼就看不見字了。撕一張再貼。`);

  // z 取當前最大 +1：新貼的一定在最上面，這是人拖放時的預期
  const { data: top } = await db.from("placed_stickers").select("z")
    .eq("user_id", uid).eq("surface", surface).order("z", { ascending: false }).limit(1);
  const z = (((top ?? [])[0] as { z: number } | undefined)?.z ?? 0) + 1;

  const { data: row, error } = await db.from("placed_stickers").insert({
    user_id: uid, surface, sticker_id: stickerId, anchor, anchor_id: anchorId,
    // anchor='page' 時 x 是寬度 0..1；錨在元素上時是 px 偏移，允許負值（壓在角上露一半）
    x: anchor === "page" ? clamp(p.x, 0, 1, 0.5) : clamp(p.x, -400, 400, 0),
    y: anchor === "page" ? clamp(p.y, 0, 100_000, 0) : clamp(p.y, -400, 400, 0),
    rot: clamp(p.rot, -180, 180, 0),
    scale: clamp(p.scale, 0.4, 3, 1),
    z,
  }).select("id, surface, sticker_id, anchor, anchor_id, x, y, rot, scale, z").single();
  if (error) { console.error("placeSticker failed", error); return err("貼不上去，稍後再試"); }
  return ok({ sticker: row, count: (count ?? 0) + 1, max: MAX_PER_SURFACE });
}

/** 移動／旋轉／縮放／提到最上層。只改有送來的欄位。 */
export async function moveSticker(
  db: SupabaseClient, uid: string,
  p: { id?: unknown; x?: unknown; y?: unknown; rot?: unknown; scale?: unknown; front?: unknown },
): Promise<StickerResult> {
  const id = String(p.id ?? "");
  const { data: cur } = await db.from("placed_stickers")
    .select("id, surface, anchor").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!cur) return err("查無這張貼紙");
  const row = cur as { id: string; surface: string; anchor: string };

  const patch: Record<string, number> = {};
  if (p.x !== undefined) patch.x = row.anchor === "page" ? clamp(p.x, 0, 1, 0.5) : clamp(p.x, -400, 400, 0);
  if (p.y !== undefined) patch.y = row.anchor === "page" ? clamp(p.y, 0, 100_000, 0) : clamp(p.y, -400, 400, 0);
  if (p.rot !== undefined) patch.rot = clamp(p.rot, -180, 180, 0);
  if (p.scale !== undefined) patch.scale = clamp(p.scale, 0.4, 3, 1);
  if (p.front) {
    const { data: top } = await db.from("placed_stickers").select("z")
      .eq("user_id", uid).eq("surface", row.surface).order("z", { ascending: false }).limit(1);
    patch.z = (((top ?? [])[0] as { z: number } | undefined)?.z ?? 0) + 1;
  }
  if (!Object.keys(patch).length) return ok({ id, unchanged: true });

  const { data: out } = await db.from("placed_stickers").update(patch)
    .eq("id", id).eq("user_id", uid)
    .select("id, surface, sticker_id, anchor, anchor_id, x, y, rot, scale, z");
  return ok({ sticker: (out ?? [])[0] ?? null });
}

export async function removeSticker(db: SupabaseClient, uid: string, id: unknown): Promise<StickerResult> {
  const sid = String(id ?? "");
  const { data: cur } = await db.from("placed_stickers").select("id").eq("id", sid).eq("user_id", uid).maybeSingle();
  if (!cur) return err("查無這張貼紙");
  await db.from("placed_stickers").delete().eq("id", sid).eq("user_id", uid);
  return ok({ id: sid, removed: true });
}

/** 某一頁貼了什麼。心跡各頁的回應會直接夾帶它，不必為了貼紙多打一支。 */
export async function layoutOf(db: SupabaseClient, uid: string, surface: string) {
  const s = validSurface(surface);
  if (!s) return [];
  const { data } = await db.from("placed_stickers")
    .select("id, sticker_id, anchor, anchor_id, x, y, rot, scale, z")
    .eq("user_id", uid).eq("surface", s).order("z", { ascending: true });
  return data ?? [];
}

export async function stickerLayout(db: SupabaseClient, uid: string, surface: unknown): Promise<StickerResult> {
  const s = validSurface(surface);
  if (!s) return err("沒有這一頁");
  return ok({ surface: s, stickers: await layoutOf(db, uid, s) });
}
