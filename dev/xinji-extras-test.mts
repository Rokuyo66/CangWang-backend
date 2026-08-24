// dev/xinji-extras-test.mts — 貼紙與收藏語音的規則測試。
//
// 驗的同樣是承諾：免費包不必買也不必寫進 owned_packs、沒買的包貼不上去、
// 一頁貼滿要擋、新貼的一定在最上層、錨在卡片上的貼紙可以有負偏移（壓在角上）；
// 語音的額度在「上傳之前」就擋掉、同一段話收兩次是同一則、
// 沒真的上傳完就不算收成、storage_path 絕不下發。
//
// 跑法：node dev/xinji-extras-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  stickerShelf, buyPack, placeSticker, moveSticker, removeSticker, stickerLayout,
  MAX_PER_SURFACE,
} from "../supabase/functions/_shared/stickers.ts";
import {
  voiceSave, voiceConfirm, voiceList, voiceDelete, clipQuotaOf, MAX_CLIP_BYTES,
  type VoiceStore,
} from "../supabase/functions/_shared/voice.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.stack ?? e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1", V = "user-2";
const P = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const E = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

/** 照 0046 的種子建口袋 */
async function seedShelf(db: any) {
  for (const p of [
    { id: "guanzhong", name: "觀中常備", blurb: "", price: 0, sort: 1, active: true },
    { id: "miao", name: "觀喵の日常", blurb: "", price: 0, sort: 2, active: true },
    { id: "jieqi", name: "節氣・二十四", blurb: "", price: 160, sort: 3, active: true },
    { id: "off", name: "已下架的", blurb: "", price: 99, sort: 9, active: false },
  ]) await db.from("sticker_packs").insert(p);
  for (const s of [
    { id: "coin", pack_id: "guanzhong", name: "銅錢", asset: "coin", sort: 1 },
    { id: "star", pack_id: "guanzhong", name: "星", asset: "star", sort: 2 },
    { id: "paw", pack_id: "miao", name: "貓爪", asset: "paw", sort: 1 },
    { id: "lichun", pack_id: "jieqi", name: "立春", asset: "lichun", sort: 1 },
    { id: "ghost", pack_id: "off", name: "下架的", asset: "ghost", sort: 1 },
  ]) await db.from("stickers").insert(s);
}

/** Storage 替身：記得哪些路徑「已經傳好了」 */
function fakeStore() {
  const files = new Map<string, number>();
  const store: VoiceStore & { files: Map<string, number>; signed: string[] } = {
    files, signed: [],
    async signUpload(path) { store.signed.push(path); return { url: "https://x/" + path, token: "tk" }; },
    async signDownload(path) { return files.has(path) ? "https://dl/" + path : null; },
    async exists(path) { const b = files.get(path); return b == null ? null : { bytes: b }; },
    async remove(path) { files.delete(path); },
  };
  return store;
}

console.log("\n貼紙\n");

await t("免費包不必買也不必寫進 owned_packs，就已經是他的", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const shelf = P(await stickerShelf(db, U));
  const free = shelf.packs.filter((p: any) => p.price === 0);
  eq(free.length, 2, "該有兩包免費");
  ok(free.every((p: any) => p.owned), "免費包該一律視同已有");
  const { data: rows } = await db.from("owned_packs").select("*").eq("user_id", U);
  eq(rows.length, 0, "不該為了免費包寫任何一列——漏跑補資料的舊帳號就永遠少一包");
});

await t("已擁有的排前面，下架的完全不出現", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const shelf = P(await stickerShelf(db, U));
  eq(shelf.packs.some((p: any) => p.id === "off"), false, "下架的不該出現");
  const owned = shelf.packs.map((p: any) => p.owned);
  eq(owned.slice(0, 2).every(Boolean), true, "已有的該在前");
  eq(owned[2], false, "未購的在後");
  eq(shelf.max_per_surface, MAX_PER_SURFACE, "一頁上限該帶出來");
});

await t("沒買的包，貼紙貼不上去", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const msg = E(await placeSticker(db, U, { surface: "timeline", sticker_id: "lichun" }));
  ok(msg.includes("還不是你的"), "訊息該說清楚，得到：" + msg);
});

await t("買了就貼得上去；錢先扣，扣不動就不給包", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  E(await buyPack(db, U, "jieqi", async () => false));            // 扣不動
  const { data: none } = await db.from("owned_packs").select("*").eq("user_id", U);
  eq(none.length, 0, "扣不動卻把包給出去了");

  let charged = 0;
  const bought = P(await buyPack(db, U, "jieqi", async (price: number) => { charged = price; return true; }));
  eq(charged, 160, "扣的價錢不對");
  eq(bought.paid, 160, "回傳的價錢不對");
  P(await placeSticker(db, U, { surface: "timeline", sticker_id: "lichun" }));
});

await t("免費包買不了，同一包也買不了第二次", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  ok(E(await buyPack(db, U, "guanzhong", async () => true)).includes("本來就是"), "免費包該擋");
  P(await buyPack(db, U, "jieqi", async () => true));
  let charged = false;
  ok(E(await buyPack(db, U, "jieqi", async () => { charged = true; return true; })).includes("已經在"), "重複購買該擋");
  eq(charged, false, "重複購買不該再扣一次錢");
});

await t("貼在哪一頁要合法；thread:／month: 認得出來", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  E(await placeSticker(db, U, { surface: "隨便亂打", sticker_id: "coin" }));
  E(await placeSticker(db, U, { surface: "thread:not-a-uuid", sticker_id: "coin" }));
  P(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin" }));
  P(await placeSticker(db, U, { surface: "voice", sticker_id: "coin" }));
  P(await placeSticker(db, U, { surface: "month:2026-03", sticker_id: "coin" }));
  P(await placeSticker(db, U, { surface: "thread:11111111-2222-3333-4444-555555555555", sticker_id: "coin" }));
});

await t("錨在卡片上時可以有負偏移（壓在角上露一半）；貼在頁面上則夾到 0..1", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const onCard = P(await placeSticker(db, U, {
    surface: "timeline", sticker_id: "coin", anchor: "thread", anchor_id: "t1",
    x: -18, y: -14, rot: 12, scale: 1.2,
  })).sticker;
  eq(onCard.x, -18, "錨在卡片上該保留負偏移");
  eq(onCard.rot, 12, "旋轉沒存到");

  const onPage = P(await placeSticker(db, U, {
    surface: "timeline", sticker_id: "star", x: 3.7, y: -50,
  })).sticker;
  eq(onPage.x, 1, "頁面座標該夾到 0..1");
  eq(onPage.y, 0, "頁面縱座標不該是負的");
});

await t("錨不是 page 就必須有錨點", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  E(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin", anchor: "thread" }));
});

await t("新貼的一定在最上層；front 可以再提上來", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const a = P(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin" })).sticker;
  const b = P(await placeSticker(db, U, { surface: "timeline", sticker_id: "star" })).sticker;
  ok(b.z > a.z, "後貼的該在上面");
  const a2 = P(await moveSticker(db, U, { id: a.id, front: true })).sticker;
  ok(a2.z > b.z, "提到最前沒生效");
});

await t("一頁貼滿要擋，而且擋的話說得出為什麼", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  for (let i = 0; i < MAX_PER_SURFACE; i++)
    P(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin" }));
  const msg = E(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin" }));
  ok(msg.includes("看不見字"), "擋下來該說得出理由，得到：" + msg);
  // 別頁不受影響
  P(await placeSticker(db, U, { surface: "voice", sticker_id: "coin" }));
});

await t("別人的貼紙移不動也撕不掉", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const a = P(await placeSticker(db, U, { surface: "timeline", sticker_id: "coin" })).sticker;
  E(await moveSticker(db, V, { id: a.id, x: 0.9 }));
  E(await removeSticker(db, V, a.id));
  P(await removeSticker(db, U, a.id));
  eq(P(await stickerLayout(db, U, "timeline")).stickers.length, 0, "撕掉了還在");
});

await t("版面依 z 由下到上回傳，前端照順序畫就對", async () => {
  const db = fakeDb() as any;
  await seedShelf(db);
  const a = P(await placeSticker(db, U, { surface: "voice", sticker_id: "coin" })).sticker;
  const b = P(await placeSticker(db, U, { surface: "voice", sticker_id: "star" })).sticker;
  await moveSticker(db, U, { id: a.id, front: true });
  const layout = P(await stickerLayout(db, U, "voice")).stickers;
  eq(layout.length, 2, "數量不對");
  eq(layout[layout.length - 1].id, a.id, "最上面那張該排最後");
  ok(b.id, "");
});

console.log("\n收藏語音\n");

const clip = (o: Record<string, unknown> = {}) => ({
  title: "大師兄・《水天需》", subtitle: "那筆尾款・三月初二",
  character_id: "daoshi_m", kind: "reading",
  bytes: 900_000, duration_ms: 134_000, voice_id: "Chinese_bazong",
  text_hash: "h-" + Math.random().toString(36).slice(2), ...o,
});

await t("額度在「上傳之前」就擋掉，不會傳了兩 MB 才說超額", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  eq(clipQuotaOf("free"), 3, "免費 3 段");
  for (let i = 0; i < 3; i++) {
    const r = P(await voiceSave(db, U, "free", st, clip({ text_hash: "h" + i })));
    st.files.set(r.upload.path, 900_000);
    P(await voiceConfirm(db, U, st, r.clip.id));
  }
  const before = st.signed.length;
  const msg = E(await voiceSave(db, U, "free", st, clip({ text_hash: "h9" })));
  ok(msg.includes("持玉牒"), "免費滿了該指路，得到：" + msg);
  eq(st.signed.length, before, "被擋下來卻還是開了上傳網址");
});

await t("同一段話收兩次是同一則，不佔第二格也不重傳", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "free", st, clip({ text_hash: "same" })));
  st.files.set(a.upload.path, 900_000);
  P(await voiceConfirm(db, U, st, a.clip.id));

  const b = P(await voiceSave(db, U, "free", st, clip({ text_hash: "same" })));
  eq(b.duplicate, true, "該認出是同一則");
  eq(b.clip.id, a.clip.id, "回的該是原本那一則");
  eq(b.upload, null, "已經傳好了就不該再開上傳網址");
  eq(P(await voiceList(db, U, "free", st)).clips.length, 1, "不該變成兩則");
});

await t("上次收到一半沒傳完，再收會續開上傳網址而不是另建一列", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "free", st, clip({ text_hash: "half" })));
  // 不設 files → 沒傳完
  const b = P(await voiceSave(db, U, "free", st, clip({ text_hash: "half" })));
  eq(b.clip.id, a.clip.id, "該是同一列");
  ok(b.upload, "該再開一張上傳網址讓它續完");
  const { data: rows } = await db.from("voice_clips").select("id").eq("user_id", U);
  eq(rows.length, 1, "不該長出第二列");
});

await t("沒真的上傳完就不算收成，而且不出現在清單", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "free", st, clip()));
  ok(E(await voiceConfirm(db, U, st, a.clip.id)).includes("還沒上傳"), "沒檔案卻確認成功");
  eq(P(await voiceList(db, U, "free", st)).clips.length, 0, "沒傳完的不該出現在清單");

  st.files.set(a.upload.path, 812_345);
  const done = P(await voiceConfirm(db, U, st, a.clip.id));
  eq(done.clip.ready, true, "確認後該 ready");
  eq(done.clip.bytes, 812_345, "大小該以 Storage 的實況為準，不是前端說的");
});

await t("超過單檔上限：宣告時擋、上傳後發現也丟棄", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  E(await voiceSave(db, U, "free", st, clip({ bytes: MAX_CLIP_BYTES + 1 })));

  const a = P(await voiceSave(db, U, "free", st, clip({ bytes: 1000 })));
  st.files.set(a.upload.path, MAX_CLIP_BYTES + 999);     // 前端謊報大小
  ok(E(await voiceConfirm(db, U, st, a.clip.id)).includes("超過上限"), "上傳後該複驗");
  eq(st.files.has(a.upload.path), false, "超額的檔案該刪掉");
  const { data: rows } = await db.from("voice_clips").select("id").eq("user_id", U);
  eq(rows.length, 0, "那一列也該收回去");
});

await t("storage_path 絕不下發", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "zhiji", st, clip()));
  st.files.set(a.upload.path, 900_000);
  P(await voiceConfirm(db, U, st, a.clip.id));
  const list = P(await voiceList(db, U, "zhiji", st));
  const json = JSON.stringify(list.clips);
  eq(json.includes("storage_path"), false, "清單漏出了 storage_path");
  ok(list.clips[0].url.startsWith("https://dl/"), "該給短效簽名網址");
  eq(list.quota.max, 30, "配額該依方案");
});

await t("丟棄會連檔案一起刪，順序是先檔後列", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "free", st, clip()));
  st.files.set(a.upload.path, 900_000);
  P(await voiceConfirm(db, U, st, a.clip.id));
  P(await voiceDelete(db, U, st, a.clip.id));
  eq(st.files.size, 0, "檔案沒刪，bucket 會長出沒有主人的音訊");
  eq(P(await voiceList(db, U, "free", st)).clips.length, 0, "列沒刪");
});

await t("別人的收藏聽不到也刪不掉", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  const a = P(await voiceSave(db, U, "free", st, clip()));
  st.files.set(a.upload.path, 900_000);
  P(await voiceConfirm(db, U, st, a.clip.id));
  E(await voiceConfirm(db, V, st, a.clip.id));
  E(await voiceDelete(db, V, st, a.clip.id));
  eq(P(await voiceList(db, V, "free", st)).clips.length, 0, "看到別人的了");
});

await t("沒標題或沒指紋，收不下來", async () => {
  const db = fakeDb() as any; const st = fakeStore();
  E(await voiceSave(db, U, "free", st, clip({ title: "  " })));
  E(await voiceSave(db, U, "free", st, clip({ text_hash: "" })));
  E(await voiceSave(db, U, "free", st, clip({ bytes: 0 })));
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
