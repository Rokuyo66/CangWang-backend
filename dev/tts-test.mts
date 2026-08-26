// dev/tts-test.mts — 朗讀解卦的伺服端規則測試。
//
// 這一支不驗「聲音好不好聽」，驗的是三件會出事的事：
//   一、客戶端指名得動的範圍。開放送文字＝把金鑰做成公用 TTS，
//       所以只准指名「哪一卦的哪一段」，而且那一卦必須是自己的。
//   二、快取真的省下請求。重聽第二次若還是打一次 API，就是每次都付一次錢。
//   三、額度擋得住，而且不會誤傷重聽——命中快取的重聽不該吃額度。
//
// MiniMax 用假的 fetch 頂替：回傳一段真的 mp3 檔頭，因為解碼那一段
// 就是靠檔頭在判 hex 還是 base64。假回應若不是 mp3，等於沒驗到解碼。
//
// 跑法：node dev/tts-test.mts

// tts.ts 在載入時就會讀 Deno.env（端點、金鑰、上限），node 沒有這個全域。
// 金鑰給一個假的：沒有金鑰時 speakCast 會在最前面就擋下來，那樣什麼也驗不到。
(globalThis as Record<string, unknown>).Deno ??= {
  env: { get: (k: string) => (k === "MINIMAX_API_KEY" ? "test-key" : undefined) },
};

import { fakeDb } from "./fake-db.mts";
// 測試一律用無牒那一階：擋得住無牒，才是真的擋得住。
const PLAN = "free";
const { speakable, segments, chunk, decodeAudio, speakCast, castTexts } =
  await import("../supabase/functions/_shared/tts.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) =>
  ok(a === b, `${m}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

const U = "user-1";
const CAST = "cast-1";
const payloadOf = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const errOf = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

// 真的 mp3：ID3 標頭 + 一個 frame sync。解碼那一段靠檔頭判編碼，假不得。
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00]);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** 假的 MiniMax。記下被呼叫幾次與送出去的 body，好驗快取與聲線。 */
function fakeMinimax(encode = hex) {
  const calls: any[] = [];
  const doFetch: any = (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { audio: encode(MP3) }, base_resp: { status_code: 0, status_msg: "success" } }),
    });
  };
  return { doFetch, calls };
}

const seed = () => ({
  profiles: [{ id: U, lingshi: 100 }],
  casts: [
    { id: CAST, user_id: U, character_id: "daoshi_m", question: "問前程", reading: "## 斷語\n事緩則圓。\n＊他沒有轉身＊\n再等三日。" },
    { id: "cast-2", user_id: "someone-else", character_id: "daoshi_f", question: "別人的", reading: "別人的批文。" },
  ],
  followups: [
    { id: "f1", cast_id: CAST, question: "還要等多久", answer: "月半之後。", created_at: "2026-01-01T00:00:00Z" },
  ],
  tts_usage: [] as any[],
});

console.log("\n── 文本整理與分軌 ──");
await t("標題留字、分隔線與粗體記號去掉", () => {
  eq(speakable("## 斷語\n---\n事緩則圓。\n**再等**三日。"),
     "斷語\n事緩則圓。\n再等三日。", "整理後的字");
});
await t("旁白不再被丟掉，改分給旁白那把嗓子", () => {
  const segs = segments("事緩則圓。\n＊他沒有轉身＊\n再等三日。");
  eq(segs.length, 3, "段數");
  eq(segs[0].narrator, false, "第一段是台詞");
  eq(segs[1].narrator, true, "第二段是旁白");
  eq(segs[1].text, "他沒有轉身", "旁白的字（星號要脫掉）");
  eq(segs[2].narrator, false, "第三段回台詞");
});
await t("夾在句子中間的旁白也切得開，順序不變", () => {
  const segs = segments("他抬眼。＊指節在案上輕敲＊「這麼晚。」");
  eq(segs.map((s: any) => (s.narrator ? "旁" : "台")).join(""), "台旁台", "順序");
  eq(segs[2].text, "「這麼晚。」", "旁白之後那句台詞");
});
await t("相鄰同嗓合併——三行台詞是一次請求，不是三次", () => {
  const segs = segments("一。\n二。\n三。");
  eq(segs.length, 1, "段數（每一段都是一次付費請求）");
  eq(segs[0].text, "一。\n二。\n三。", "合併後的字");
});
await t("整段都是旁白時全歸旁白，不是空的", () => {
  const segs = segments("＊他沒有轉身＊\n＊只是看著你＊");
  eq(segs.length, 1, "段數");
  eq(segs[0].narrator, true, "全旁白");
  eq(segs[0].text, "他沒有轉身\n只是看著你", "合併後的字");
});

console.log("\n── 切段 ──");
await t("只在句末切，不切在句子中間", () => {
  const segs = chunk("一二三四五。六七八九十。十一十二。", 10);
  ok(segs.every((s) => /[。！？；：!?;]$/.test(s)), "每段都該以標點收尾：" + JSON.stringify(segs));
});
await t("段落邊界不是切點——四行短批文只該送一次，不是四次", () => {
  const segs = chunk("所問：問前程。\n斷語\n事緩則圓。\n再等三日。", 600);
  eq(segs.length, 1, "段數（每一段都是一次付費請求）");
  ok(segs[0].includes("問前程") && segs[0].includes("再等三日"), "頭尾都該在同一段");
});
await t("沒有標點的長串仍切得開（否則整包送不出去）", () => {
  const segs = chunk("字".repeat(25), 10);
  ok(segs.length === 3 && segs.every((s) => s.length <= 10), "硬切：" + JSON.stringify(segs.map((s) => s.length)));
});

console.log("\n── 音檔解碼 ──");
await t("hex 解得出來", () => ok(decodeAudio(hex(MP3))?.length === MP3.length, "hex"));
await t("base64 也解得出來（回應形狀不只一種）", () => ok(decodeAudio(b64(MP3))?.length === MP3.length, "base64"));
await t("不是 mp3 的東西一律回 null，不會被當音檔存起來", () => {
  eq(decodeAudio("這不是音檔"), null, "亂碼");
  eq(decodeAudio(hex(new Uint8Array([1, 2, 3, 4, 5, 6]))), null, "hex 但不是 mp3");
});

console.log("\n── 指名範圍 ──");
await t("念得到自己那一卦的批文", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  const p = payloadOf(await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch));
  ok((p.parts as any[]).length >= 1, "該有音檔");
  ok(mm.calls[0].text.includes("所問：問前程"), "提問該念進去：" + mm.calls[0].text);
});
await t("念不到別人的卦", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  eq(await speakCast(db as any, U, PLAN, "cast-2", "body", mm.doFetch).then(errOf), "找不到這一卦", "越權");
  eq(mm.calls.length, 0, "越權時不該打 API");
});
await t("追問用序號指名，指到不存在的就是不存在", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  payloadOf(await speakCast(db as any, U, PLAN, CAST, 0, mm.doFetch));
  ok(mm.calls[0].text.includes("月半之後"), "該念那一則：" + mm.calls[0].text);
  eq(await speakCast(db as any, U, PLAN, CAST, 5, mm.doFetch).then(errOf), "沒有這一則追問", "越界");
});

console.log("\n── 聲線 ──");
await t("台詞用該角色的聲線，旁白用旁白的，順序不變", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  const p = payloadOf(await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch));
  eq(p.voice_id, "Chinese_bazong", "師兄的聲線");
  eq(p.narrator_voice_id, "Chinese_gravelly_storyteller_nv1", "旁白的聲線");
  // 這一卦的批文是「台詞／旁白／台詞」，所以該送三次、三把嗓子照順序
  const sent = mm.calls.map((c: any) => c.voice_setting.voice_id);
  eq(sent.join(" > "),
     "Chinese_bazong > Chinese_gravelly_storyteller_nv1 > Chinese_bazong",
     "送出去的聲線順序");
  ok(mm.calls[1].text.includes("沒有轉身"), "旁白該由旁白那把念：" + mm.calls[1].text);
  eq((p.parts as any[]).map((x) => (x.narrator ? "旁" : "台")).join(""), "台旁台", "回傳的軌別");
});

console.log("\n── 快取 ──");
await t("重聽同一段不再打 API", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  const first = payloadOf(await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch));
  const n = mm.calls.length;
  ok(n > 0, "第一次該合成");
  eq(first.cached, false, "第一次不算快取");
  const again = payloadOf(await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch));
  eq(mm.calls.length, n, "第二次不該再打 API");
  eq(again.cached, true, "第二次該標成快取");
  eq(JSON.stringify(again.parts), JSON.stringify(first.parts), "拿到的網址該一樣");
});

console.log("\n── 額度 ──");
await t("額度用完擋得住", async () => {
  const s = seed();
  // 台北日：額度以台北日界計，用 UTC 日期會在下午四點之後放到錯的那一天
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  s.tts_usage.push({ user_id: U, day, chars: 99999 });
  const db = fakeDb(s); const mm = fakeMinimax();
  ok((await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch).then(errOf)).includes("額度"), "該擋");
  eq(mm.calls.length, 0, "擋下時不該打 API");
});
await t("額度只差一點時，不會念到一半才斷——一個字都不合成", async () => {
  const s = seed();
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  // 這一卦要念的字不只 3 個，額度只剩 3：一段一段扣的話會先合成前幾段
  // 再回失敗，使用者花了錢一個字也沒聽到。
  s.tts_usage.push({ user_id: U, day, chars: 5000 - 3 });
  const db = fakeDb(s); const mm = fakeMinimax();
  const msg = await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch).then(errOf);
  ok(msg.includes("額度"), "該擋，得到：" + msg);
  eq(mm.calls.length, 0, "擋下時一個字都不該送去合成");
  eq((db as any)._store.tts_usage[0].chars, 5000 - 3, "擋下時不該扣掉任何額度");
});

await t("命中快取的重聽不吃額度", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch);
  const used1 = (db as any)._store.tts_usage[0].chars;
  await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch);
  eq((db as any)._store.tts_usage[0].chars, used1, "重聽後用量不該增加");
});

console.log("\n── 逐字稿找得回來 ──");
await t("由指紋反查當初念的字：本體與追問都認得出來", async () => {
  const db = fakeDb(seed()); const mm = fakeMinimax();
  const body = payloadOf(await speakCast(db as any, U, PLAN, CAST, "body", mm.doFetch));
  const said = await castTexts(db as any, U, CAST, body.text_hash as string);
  eq(said?.length, (body.parts as any[]).length, "段數該與音檔一一對上");
  eq(JSON.stringify(said?.map((x: any) => x.text)),
     JSON.stringify((body.parts as any[]).map((x) => x.text)), "找回來的字該與當初念的一字不差");

  const fu = payloadOf(await speakCast(db as any, U, PLAN, CAST, 0, mm.doFetch));
  const said2 = await castTexts(db as any, U, CAST, fu.text_hash as string);
  ok(said2?.[0].text.includes("還要等多久"), "追問那一則沒認出來（序號沒存進收藏，只能靠指紋認）");
});
await t("指紋對不上、或那一卦不是自己的，一律回 null——不硬配一段別的文字", async () => {
  const db = fakeDb(seed());
  eq(await castTexts(db as any, U, CAST, "0".repeat(64)), null, "對不上卻給了字");
  eq(await castTexts(db as any, U, "cast-2", "0".repeat(64)), null, "撈得到別人的卦");
  eq(await castTexts(db as any, U, "", "abc"), null, "沒指名也回東西");
});

console.log("\n── 失敗 ──");
await t("base_resp 說失敗時不把錯誤當音檔存起來", async () => {
  const db = fakeDb(seed());
  const doFetch: any = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
  });
  const msg = await speakCast(db as any, U, PLAN, CAST, "body", doFetch).then(errOf);
  ok(msg.includes("1004") && msg.includes("invalid api key"), "該把原因帶出來：" + msg);
  eq((db as any)._store._files.size, 0, "不該存下任何檔");
});
await t("回應沒有音檔欄位時，把看到的鍵帶回來（不必再猜形狀）", async () => {
  const db = fakeDb(seed());
  const doFetch: any = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ trace_id: "x", extra_info: {} }) });
  const msg = await speakCast(db as any, U, PLAN, CAST, "body", doFetch).then(errOf);
  ok(msg.includes("trace_id") && msg.includes("extra_info"), "該列出鍵：" + msg);
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
