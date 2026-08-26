// dev/xinji-extras-test.mts — 貼紙與收藏語音的規則測試。
//
// 驗的同樣是承諾：免費包不必買也不必寫進 owned_packs、沒買的包貼不上去、
// 一頁貼滿要擋、新貼的一定在最上層、錨在卡片上的貼紙可以有負偏移（壓在角上）；
// 語音的收藏是記指標不是複製檔案、同一段話收兩次是同一則、
// **格數只擋「再收新的」，不擋保留與重聽**（玉牒到期不該讓收藏消失）、
// 丟一則收藏不刪共用快取、storage 路徑絕不下發。
//
// 跑法：node dev/xinji-extras-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  stickerShelf, buyPack, placeSticker, moveSticker, removeSticker, stickerLayout,
  MAX_PER_SURFACE,
} from "../supabase/functions/_shared/stickers.ts";
import {
  voiceKeep, voiceList, voiceDelete, clipQuotaOf, type Speak,
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

/** 合成替身：記下被要求念了幾次，並吐出 speakCast 那個形狀的 payload。
 *  真正的 speakCast 命中快取時不扣額度——這裡用 calls 驗「收藏沒有多合成一次」。 */
function fakeSpeak(opts: { fail?: string; hash?: string } = {}) {
  const calls: string[] = [];
  const speak: Speak & { calls: string[] } = Object.assign(
    async (castId: string, part: "body" | number) => {
      calls.push(`${castId}#${part}`);
      if (opts.fail) return { ok: false as const, msg: opts.fail };
      const h = opts.hash ?? `hash-${castId}-${part}`;
      return {
        ok: true as const,
        payload: {
          parts: [
            { url: "https://tts/a.mp3", path: "a.mp3", chars: 300, narrator: false },
            { url: "https://tts/b.mp3", path: "b.mp3", chars: 120, narrator: true },
          ],
          text_hash: h, title: "《水天需》", subtitle: "那筆尾款收得回來嗎",
          character_id: "daoshi_m", voice_id: "Chinese_bazong",
          quota: { used: 420, max: 2000, left: 1580, day_used: 420, day_max: 3000 },
        },
      };
    },
    { calls },
  );
  return speak;
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

await t("收藏是記指標，不是複製檔案——parts 照播放順序下發", async () => {
  const db = fakeDb() as any; const sp = fakeSpeak();
  const r = P(await voiceKeep(db, U, "free", sp, { cast_id: "c1", part: "body" }));
  eq(r.duplicate, false, "第一次收不該算重複");
  eq(r.clip.parts.length, 2, "兩段音檔該都留著");
  eq(r.clip.parts[0].url, "https://tts/a.mp3", "順序錯了");
  eq(r.clip.parts[1].narrator, true, "旁白那一段的標記掉了");
  eq(r.clip.title, "《水天需》", "標題該由伺服器決定");
  // 420 字 ÷ 4.5 字/秒 ≈ 93 秒。估的，但清單上要說得出一個長度
  eq(r.clip.duration_ms, 93333, "長度該由字數估出來");
});

await t("收藏走的是與朗讀相同的那條路，不另外合成第二次", async () => {
  const db = fakeDb() as any; const sp = fakeSpeak();
  P(await voiceKeep(db, U, "free", sp, { cast_id: "c1", part: "body" }));
  eq(sp.calls.length, 1, "收一次該只經過合成路徑一次");
  eq(sp.calls[0], "c1#body", "問錯段落了");
});

await t("合成那邊擋下來（額度用完、查無此卦），原話帶回去", async () => {
  const db = fakeDb() as any;
  const sp = fakeSpeak({ fail: "這個月的朗讀額度用完了" });
  const msg = E(await voiceKeep(db, U, "free", sp, { cast_id: "c1", part: "body" }));
  ok(msg.includes("額度用完"), "該把合成那一層的話原樣帶回，得到：" + msg);
  const { data: rows } = await db.from("voice_clips").select("id").eq("user_id", U);
  eq(rows.length, 0, "沒收成卻留下了一列");
});

await t("同一段話收兩次是同一則，不佔第二格", async () => {
  const db = fakeDb() as any; const sp = fakeSpeak({ hash: "same" });
  const a = P(await voiceKeep(db, U, "free", sp, { cast_id: "c1", part: "body" }));
  const b = P(await voiceKeep(db, U, "free", sp, { cast_id: "c1", part: "body" }));
  eq(b.duplicate, true, "該認出是同一則");
  eq(b.clip.id, a.clip.id, "回的該是原本那一則");
  eq(P(await voiceList(db, U, "free")).clips.length, 1, "不該變成兩則");
});

await t("免費格數滿了要擋，而且要指得出路", async () => {
  const db = fakeDb() as any;
  eq(clipQuotaOf("free"), 3, "免費 3 段");
  for (let i = 0; i < 3; i++) {
    P(await voiceKeep(db, U, "free", fakeSpeak({ hash: "h" + i }), { cast_id: "c" + i }));
  }
  const msg = E(await voiceKeep(db, U, "free", fakeSpeak({ hash: "h9" }), { cast_id: "c9" }));
  ok(msg.includes("持玉牒"), "免費滿了該指路，得到：" + msg);
});

await t("玉牒到期：既有收藏一段都不會消失，也照聽，只是收不了新的", async () => {
  const db = fakeDb() as any;
  // 藏往時期收了 5 段
  for (let i = 0; i < 5; i++) {
    P(await voiceKeep(db, U, "cangwang", fakeSpeak({ hash: "k" + i }), { cast_id: "c" + i }));
  }
  // 掉回無牒
  const list = P(await voiceList(db, U, "free"));
  eq(list.clips.length, 5, "既有收藏被藏起來或刪掉了——那是他的東西");
  eq(list.quota.used, 5, "used 該照實回報");
  eq(list.quota.max, 3, "max 該是現在這一階");
  eq(list.quota.can_add, false, "超額時不該還能再收");
  ok(list.clips.every((c: any) => c.parts.length === 2), "重聽要用的 parts 不該被拿掉");

  const msg = E(await voiceKeep(db, U, "free", fakeSpeak({ hash: "new" }), { cast_id: "cx" }));
  ok(msg.includes("滿了"), "超額時該擋新的，得到：" + msg);
});

await t("丟一則收藏不刪音檔——那是全站共用的快取", async () => {
  const db = fakeDb() as any; const sp = fakeSpeak({ hash: "one" });
  const a = P(await voiceKeep(db, U, "free", sp, { cast_id: "c1" }));
  P(await voiceDelete(db, U, a.clip.id));
  eq(P(await voiceList(db, U, "free")).clips.length, 0, "列沒刪");

  // 同一段話再收一次：因為音檔還在，這是零成本的
  const again = P(await voiceKeep(db, U, "free", sp, { cast_id: "c1" }));
  eq(again.clip.parts.length, 2, "音檔被刪掉了，再收就得重新付錢合成");
});

await t("storage 路徑絕不下發", async () => {
  const db = fakeDb() as any;
  P(await voiceKeep(db, U, "zhiji", fakeSpeak(), { cast_id: "c1" }));
  const list = P(await voiceList(db, U, "zhiji"));
  const json = JSON.stringify(list.clips);
  eq(json.includes("storage_path"), false, "清單漏出了 storage_path");
  eq(json.includes('"path"'), false, "parts 裡的內部路徑漏出去了");
  ok(list.clips[0].parts[0].url.startsWith("https://tts/"), "播放網址該留著");
  eq(list.quota.max, 30, "配額該依方案");
});

await t("別人的收藏看不到也刪不掉", async () => {
  const db = fakeDb() as any;
  const a = P(await voiceKeep(db, U, "free", fakeSpeak(), { cast_id: "c1" }));
  E(await voiceDelete(db, V, a.clip.id));
  eq(P(await voiceList(db, V, "free")).clips.length, 0, "看到別人的了");
  eq(P(await voiceList(db, U, "free")).clips.length, 1, "別人刪掉了我的");
});

await t("沒說收哪一卦、或那一段沒有聲音，收不下來", async () => {
  const db = fakeDb() as any;
  E(await voiceKeep(db, U, "free", fakeSpeak(), { cast_id: "  " }));
  E(await voiceKeep(db, U, "free", fakeSpeak(), { cast_id: "c1", part: "第三則" }));
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
if (fail) process.exit(1);
