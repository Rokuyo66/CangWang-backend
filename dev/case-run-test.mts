// dev/case-run-test.mts — 卦案伺服端服務層的規則測試。
//
// 驗的不是「引擎算得對不對」（那是 case-sim / case-schema-test 的事），
// 而是「把引擎搬到伺服器上之後，客戶端還能不能作弊」：
// 能不能自己選卦、能不能做此刻做不到的事、能不能提早看到 truth、
// 能不能同時開兩局、能不能多留幾份記憶檔案、結案之後還能不能再寫。
//
// 跑法：node dev/case-run-test.mts

import { fakeDb } from "./fake-db.mts";
import {
  listCases, startCase, caseStateOf, actOnCase, keepRun, deleteRun, parseAction, keptQuota,
} from "../supabase/functions/_shared/case-run.ts";
import { HUANGCUN } from "../supabase/functions/_shared/cases/huangcun.ts";
import { buildChart, castCoins } from "../supabase/functions/_shared/core.ts";
import { projectCase } from "../supabase/functions/_shared/case.ts";
import { toCaseDef } from "../supabase/functions/_shared/case-schema.ts";

let pass = 0, fail = 0;
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); },
  );
}
function ok(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const eq = (a: unknown, b: unknown, msg: string) => ok(a === b, `${msg}（得到 ${JSON.stringify(a)}，預期 ${JSON.stringify(b)}）`);

/** 固定種子的 PRNG：同一個 seed 必得同一支卦，測起來才可重現 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const U = "user-1";
const payloadOf = (r: any) => { ok(r.ok, "預期成功，卻得到：" + (r.msg ?? "")); return r.payload; };
const errOf = (r: any) => { ok(!r.ok, "預期失敗，卻成功了"); return r.msg; };

console.log("\n卦案存檔服務層\n");

/* ═══ 進案 ═══ */

await t("進案會建檔，並回一份可直接重畫的畫面", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", "daoshi_m", seeded(1)));
  ok(p.run_id, "缺 run_id");
  eq(p.case_id, "huangcun", "case_id 不對");
  eq(p.resumed, false, "第一次進案不該是 resumed");
  eq(p.companion_name, "師兄", "同行名字不對");
  ok(p.gua?.benName, "缺卦名");
  ok(p.region?.name, "缺當前區域");
  ok(p.options?.length > 0, "沒有任何可選行動");
  ok(Array.isArray(p.log) && p.log.length >= 4, "開場日誌不足");
  eq(db._store.case_runs.length, 1, "應只建一筆存檔");
});

await t("卦由伺服器擲：同一顆亂數源必得同一支卦，換一顆就換一支", async () => {
  // 起卦權在伺服器，是靠「lines 只可能來自 startCase 自己呼叫的 castCoins」成立的。
  // 這裡驗的就是那條路徑：卦完全由注入的亂數源決定，呼叫端沒有第二個入口能左右它。
  const linesFor = async (seed: number) => {
    const db = fakeDb() as any;
    await startCase(db, "u" + seed, "huangcun", null, seeded(seed));
    return db._store.case_runs[0].lines as number[];
  };
  const a = await linesFor(7), again = await linesFor(7), b = await linesFor(8);
  eq(a.length, 6, "lines 應為 6 爻");
  ok(a.every((v) => [6, 7, 8, 9].includes(v)), "lines 值域應為 6/7/8/9");
  eq(a.join(), again.join(), "同一顆亂數源卻擲出不同的卦");
  ok(a.join() !== b.join(), "換了亂數源卻擲出同一支卦");
});

await t("同一人同一案只開得出一局，再進案是讀回原局", async () => {
  const db = fakeDb() as any;
  const a = payloadOf(await startCase(db, U, "huangcun", "daoshi_f", seeded(2)));
  const b = payloadOf(await startCase(db, U, "huangcun", "lingshou", seeded(999)));
  eq(b.resumed, true, "第二次進案應是讀回原局");
  eq(b.run_id, a.run_id, "應是同一局");
  eq(b.companion_name, "師妹", "同行不該被第二次進案改掉");
  eq(db._store.case_runs.length, 1, "不該開出第二局");
});

await t("查無此案、不存在的同行，都擋在建檔之前", async () => {
  const db = fakeDb() as any;
  eq(errOf(await startCase(db, U, "no_such_case", null, seeded(3))), "查無此案", "案件白名單沒擋住");
  eq(errOf(await startCase(db, U, "huangcun", "someone_else", seeded(3))), "此案沒有這位同行", "同行沒擋住");
  eq(db._store.case_runs?.length ?? 0, 0, "擋掉的請求不該留下存檔");
});

await t("兩個人各開各的局，互不相干", async () => {
  const db = fakeDb() as any;
  await startCase(db, U, "huangcun", null, seeded(4));
  await startCase(db, "user-2", "huangcun", null, seeded(5));
  eq(db._store.case_runs.length, 2, "兩人應各有一局");
});

/* ═══ 越權 ═══ */

await t("拿到別人的 run_id 也讀不到、動不了", async () => {
  const db = fakeDb() as any;
  const mine = payloadOf(await startCase(db, U, "huangcun", null, seeded(6)));
  eq(errOf(await caseStateOf(db, "user-2", mine.run_id)), "查無此存檔", "別人讀得到我的存檔");
  eq(errOf(await actOnCase(db, "user-2", mine.run_id, { kind: "search" })), "查無此存檔", "別人動得了我的存檔");
});

await t("此刻做不到的事一律回絕，不是靜靜地沒反應", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(8)));
  const before = JSON.stringify(db._store.case_runs[0].state);

  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "move", to: 99 })), "此刻做不到這件事", "走到不存在的區沒被擋");
  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "inspect", objectId: "o_nope" })), "此刻做不到這件事", "查看不存在的物件沒被擋");
  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "talk", npcId: "n_nope" })), "此刻做不到這件事", "跟不存在的人攀談沒被擋");
  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "teleport" } as any)), "認不得這個行動", "沒見過的行動沒被擋");
  eq(errOf(await actOnCase(db, U, p.run_id, null)), "認不得這個行動", "空行動沒被擋");

  eq(JSON.stringify(db._store.case_runs[0].state), before, "被擋下的行動不該改到存檔");
});

await t("沒搜過的區不能直接查看裡面的東西", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(11)));
  const here = HUANGCUN.regions.find((r) => r.pos === p.region.pos)!;
  eq(p.region.searched, false, "開局不該是已搜索狀態");
  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "inspect", objectId: here.objects[0].id })),
    "此刻做不到這件事", "跳過搜索直接查看沒被擋");
});

await t("parseAction 只認得六種行動", () => {
  eq(parseAction({ kind: "search" })?.kind, "search", "search");
  eq(parseAction({ kind: "move", to: 3 })?.kind, "move", "move");
  eq(parseAction({ kind: "move", to: "3" }), null, "區號是字串就該回絕");
  eq(parseAction({ kind: "move" }), null, "缺 to 就該回絕");
  eq(parseAction({ kind: "inspect" }), null, "缺 objectId 就該回絕");
  eq(parseAction("search" as any), null, "字串不是行動");
  eq(parseAction(undefined), null, "undefined 不是行動");
});

/* ═══ 行動與存檔 ═══ */

await t("搜索會推進世界時間並寫回存檔", async () => {
  const db = fakeDb() as any;
  const p0 = payloadOf(await startCase(db, U, "huangcun", null, seeded(12)));
  const p1 = payloadOf(await actOnCase(db, U, p0.run_id, { kind: "search" }));
  eq(p1.minute - p0.minute, 3, "搜索應花 3 分鐘");
  eq(p1.region.searched, true, "搜完應標記為已搜索");
  ok(p1.log.length > p0.log.length, "日誌沒有增長");
  eq(db._store.case_runs[0].state.minute, p1.minute, "存檔沒有跟著寫回");
});

await t("同一局的兩個行動同時寫回，後到的那個撞掉而不是覆蓋", async () => {
  const db = fakeDb() as any;
  const p0 = payloadOf(await startCase(db, U, "huangcun", null, seeded(21)));

  // 兩個請求同時進來：都讀到同一份存檔（seq 0），各自算完才寫回。
  // 交錯是靠 fakeDb 的同步性製造的——兩支 promise 都建立好，才一起等。
  const a = actOnCase(db, U, p0.run_id, { kind: "search" });
  const b = actOnCase(db, U, p0.run_id, { kind: "search" });
  const [ra, rb]: any[] = await Promise.all([a, b]);

  const wins = [ra, rb].filter((r) => r.ok);
  const loses = [ra, rb].filter((r) => !r.ok);
  eq(wins.length, 1, "兩個都寫成功了，等於一個行動被靜靜蓋掉");
  eq(loses.length, 1, "應有一個撞掉");
  eq(loses[0].msg, "動作重疊了，請再試一次", "撞掉的訊息不對");
  eq(db._store.case_runs[0].seq, 1, "只該推進一號");
  eq(wins[0].payload.minute - p0.minute, 3, "只該花掉一次搜索的時間");
});

await t("重讀存檔會得到一模一樣的畫面（純函數重建）", async () => {
  const db = fakeDb() as any;
  const p0 = payloadOf(await startCase(db, U, "huangcun", "lingshou", seeded(13)));
  await actOnCase(db, U, p0.run_id, { kind: "search" });
  const a = payloadOf(await caseStateOf(db, U, p0.run_id));
  const b = payloadOf(await caseStateOf(db, U, p0.run_id));
  eq(JSON.stringify(a), JSON.stringify(b), "同一份存檔讀兩次不一致");
});

await t("結案之後就再也寫不進去", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(14)));
  const done = payloadOf(await actOnCase(db, U, p.run_id, { kind: "end" }));
  eq(done.ended, true, "結案沒生效");
  ok(done.review, "結案應附上案件回顧");
  eq(done.region, null, "結案後不該再回當前區域");
  eq(done.options.length, 0, "結案後不該還有可選行動");
  eq(errOf(await actOnCase(db, U, p.run_id, { kind: "search" })), "這一局已經結案了", "結案後還能行動");
});

await t("結案後同一案可以再開新的一局", async () => {
  const db = fakeDb() as any;
  const a = payloadOf(await startCase(db, U, "huangcun", null, seeded(15)));
  await actOnCase(db, U, a.run_id, { kind: "end" });
  const b = payloadOf(await startCase(db, U, "huangcun", null, seeded(16)));
  eq(b.resumed, false, "應是新的一局");
  ok(b.run_id !== a.run_id, "新局不該沿用舊 run_id");
  eq(db._store.case_runs.length, 2, "應留下兩筆存檔");
});

/* ═══ 不該提早外流的東西 ═══ */

await t("開局那一包不含 truth、線索內文、物件描述、NPC 聲口", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", "daoshi_m", seeded(17)));
  const json = JSON.stringify(p);

  ok(!json.includes(HUANGCUN.truth.slice(0, 20)), "truth 外流了");
  for (const c of HUANGCUN.clues)
    ok(!json.includes(c.text.slice(0, 16)), `線索內文外流：${c.name}`);
  for (const r of HUANGCUN.regions)
    for (const o of r.objects)
      ok(!json.includes(o.desc.slice(0, 16)), `物件描述外流：${o.name}`);
  for (const n of HUANGCUN.npcs)
    ok(!json.includes(n.voice.slice(0, 12)), `NPC 聲口外流：${n.name}`);
  eq(p.clues.held.length, 0, "開局不該持有任何道具");
  eq(p.clues.known.length, 0, "開局不該已看出任何線索");
});

await t("當前區域的物件只出名字，不出描述也不出它有沒有料", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(18)));
  for (const o of p.region.objects) {
    ok(o.id && o.name, "物件缺 id/name");
    eq("desc" in o, false, "物件不該帶 desc");
    eq("clue" in o, false, "物件不該帶 clue（等於直接指出哪個有料）");
  }
  for (const n of p.region.npcs) eq("voice" in n, false, "NPC 不該帶 voice");
});

/* ═══ 把整局走完 ═══ */

/** 窮舉型機器人：把整張地圖反覆翻到沒有新線索為止，然後結案。
 *
 *  每一輪都重看一遍所有物件，不是「看過就跳過」——擋住的東西要拿到前置之後才掀得開，
 *  「看過了」不等於「拿到了」。少了這一點，地窖那塊板子永遠掀不開，
 *  於是每一局都會是「沒破案」，而那個綠燈什麼也沒驗到。 */
async function playOut(db: any, uid: string, runId: string, startPayload: any) {
  let p = startPayload;
  const act = async (action: any) => {
    const r: any = await actOnCase(db, uid, runId, action);
    if (r.ok) p = r.payload;                       // 此刻做不到就當沒這回事
    ok(p.review === null, "還沒結案就出現了案件回顧");
    ok(!JSON.stringify(p).includes(HUANGCUN.truth.slice(0, 20)), "局中就外流 truth");
  };
  const can = (kind: string, key?: string) => p.options.some((o: any) =>
    o.action.kind === kind && (!key || o.action.objectId === key || o.action.npcId === key));
  const clueCount = () => p.clues.held.length + p.clues.known.length;

  for (let sweep = 0; sweep < 8; sweep++) {
    const before = clueCount();
    for (const pos of HUANGCUN.regions.map((r) => r.pos)) {
      if (p.region.pos !== pos) await act({ kind: "move", to: pos });
      if (p.region.pos !== pos) continue;
      if (!p.region.searched) await act({ kind: "search" });
      for (const o of p.region.objects.map((x: any) => x.id)) if (can("inspect", o)) await act({ kind: "inspect", objectId: o });
      for (const n of p.region.npcs.map((x: any) => x.id)) if (can("talk", n)) await act({ kind: "talk", npcId: n });
      if (can("companion")) await act({ kind: "companion" });
    }
    if (clueCount() === before) break;
  }
  return payloadOf(await actOnCase(db, uid, runId, { kind: "end" }));
}

await t("truth 只在破案時出現，其餘一律 null", async () => {
  let solvedRuns = 0;
  for (let seed = 100; seed < 120; seed++) {
    const db = fakeDb() as any;
    const p0 = payloadOf(await startCase(db, U, "huangcun", "daoshi_m", seeded(seed)));
    const p = await playOut(db, U, p0.run_id, p0);

    eq(p.review.truth !== null, p.review.solved, "truth 的有無與破案與否對不上");
    if (p.review.solved) { solvedRuns++; eq(typeof p.review.truth, "string", "破了案卻沒給 truth"); }
    ok(p.review.missed_count >= 0, "未發現線索應只回數量");
    ok(!("missed" in p.review), "未發現的線索不該回名字");
    eq(db._store.case_runs[0].solved, p.review.solved, "solved 欄位沒跟著寫回");
  }
  ok(solvedRuns > 0, "二十局沒有一局破案，機器人或引擎有問題");
});

await t("沒找到就是沒找到：中途收工，結案不給 truth", async () => {
  // 這一條刻意不靠「真空局」來製造沒破案。真空（access:"void"）是唯一擋死關鍵
  // 線索的代價，但它出不出得來要看當天的日辰——2026-08-23 掃過 20 萬顆種子，
  // 一個真空局都沒有。把服務層的測試綁在那上面，等於讓它每隔幾天自己紅一次，
  // 而紅的原因與這一層無關。
  // 玩家半途收工是同一條程式路徑（review 的 solved=false / truth=null），
  // 而且哪一天跑都成立。真空局的行為由 case-lint／case-sim 那邊負責。
  const db = fakeDb() as any;
  const p0 = payloadOf(await startCase(db, U, "huangcun", null, seeded(200)));
  let p = p0;
  const act = async (a: any) => { const r: any = await actOnCase(db, U, p0.run_id, a); if (r.ok) p = r.payload; };
  await act({ kind: "search" });
  for (const o of p.region.objects.map((x: any) => x.id)) await act({ kind: "inspect", objectId: o });
  const done = payloadOf(await actOnCase(db, U, p0.run_id, { kind: "end" }));

  eq(done.review.solved, false, "才翻一區就破案了？");
  eq(done.review.truth, null, "沒破案卻給了 truth");
  ok(done.review.missed_count > 0, "應該還有一堆沒發現的線索");
  eq(db._store.case_runs[0].solved, false, "solved 欄位沒跟著寫回");
});

await t("真空局（今天的日辰有的話才驗）：翻遍地圖仍拿不到關鍵線索", async () => {
  // 真空只作用在「關鍵線索區的那個物件」上，要擋死破案得讓關鍵區落在 4 或 6
  // ——地窖入口的兩條前置正好在那兩區。也刻意獨自前往：同行帶回來的線索
  // 不經 blockedReason，有人同行就繞得過去。
  const now = new Date(Date.now() + 8 * 3600_000);
  const [y, mo, d] = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
  let seed = -1;
  for (let s = 0; s < 20000; s++) {
    const { lines } = castCoins(seeded(s));
    const st = projectCase(buildChart(lines, y, mo, d, HUANGCUN.entryHour!), toCaseDef(HUANGCUN));
    if (st.access === "void" && (st.key.pos === 4 || st.key.pos === 6)) { seed = s; break; }
  }
  if (seed < 0) { console.log("     （今天的日辰下沒有真空局，跳過——這是曆法，不是 bug）"); return; }

  const db = fakeDb() as any;
  const p0 = payloadOf(await startCase(db, U, "huangcun", null, seeded(seed)));
  eq(p0.gua.access, "void", "挑出來的不是真空局");
  const p = await playOut(db, U, p0.run_id, p0);
  eq(p.review.solved, false, "真空局竟然破了案");
  eq(p.review.truth, null, "沒破案卻給了 truth");
  ok(p.review.found.length > 0, "白跑不等於什麼都沒查到——仍該留下已發現的線索");
});

/* ═══ 記憶檔案 ═══ */

async function endedRun(db: any, caseSeed: number) {
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(caseSeed)));
  return payloadOf(await actOnCase(db, U, p.run_id, { kind: "end" }));
}

await t("記憶檔案：免費 1 格、付費 3 格", () => {
  eq(keptQuota("free"), 1, "免費");
  eq(keptQuota("guanwei"), 3, "付費");
  eq(keptQuota("cangwang"), 3, "付費");
});

await t("沒結案的局封存不了", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(30)));
  eq(errOf(await keepRun(db, U, p.run_id, true, "free")), "這一局還沒結案", "進行中的局被封存了");
});

await t("配額滿了不自動覆蓋，要玩家自己捨棄一份", async () => {
  const db = fakeDb() as any;
  const a = await endedRun(db, 31);
  payloadOf(await keepRun(db, U, a.run_id, true, "free"));
  const b = await endedRun(db, 32);
  const msg = errOf(await keepRun(db, U, b.run_id, true, "free"));
  ok(msg.includes("已滿"), "配額滿了卻沒說清楚：" + msg);
  eq(db._store.case_runs.find((r: any) => r.id === a.run_id).kept, true, "舊的那份被自動洗掉了");

  payloadOf(await keepRun(db, U, a.run_id, false, "free"));   // 捨棄
  payloadOf(await keepRun(db, U, b.run_id, true, "free"));    // 空出來就留得下
  eq(db._store.case_runs.find((r: any) => r.id === b.run_id).kept, true, "空出格子後仍留不下");
});

await t("付費三格，第四份才擋", async () => {
  const db = fakeDb() as any;
  for (const seed of [41, 42, 43]) {
    const r = await endedRun(db, seed);
    payloadOf(await keepRun(db, U, r.run_id, true, "zhiji"));
  }
  const fourth = await endedRun(db, 44);
  ok(errOf(await keepRun(db, U, fourth.run_id, true, "zhiji")).includes("已滿"), "第四份沒擋");
});

await t("重複封存同一份不會吃掉第二格", async () => {
  const db = fakeDb() as any;
  const a = await endedRun(db, 51);
  payloadOf(await keepRun(db, U, a.run_id, true, "free"));
  payloadOf(await keepRun(db, U, a.run_id, true, "free"));
  eq(db._store.case_runs.filter((r: any) => r.kept).length, 1, "同一份被算成兩格");
});

await t("進行中的局刪不掉——刪得掉就等於能重擲卦", async () => {
  const db = fakeDb() as any;
  const p = payloadOf(await startCase(db, U, "huangcun", null, seeded(65)));
  ok(errOf(await deleteRun(db, U, p.run_id)).includes("還沒結案"), "進行中的局被刪掉了");
  eq(db._store.case_runs.length, 1, "存檔不該消失");

  // 走正門：結案之後才刪得掉，而那一局已經照實記成沒破案
  await actOnCase(db, U, p.run_id, { kind: "end" });
  payloadOf(await deleteRun(db, U, p.run_id));
  eq(db._store.case_runs.length, 0, "結案後仍刪不掉");
});

await t("捨棄存檔只刪得掉自己的", async () => {
  const db = fakeDb() as any;
  const a = await endedRun(db, 61);
  eq(errOf(await deleteRun(db, "user-2", a.run_id)), "查無此存檔", "別人刪得掉我的存檔");
  eq(db._store.case_runs.length, 1, "存檔被別人刪掉了");
  payloadOf(await deleteRun(db, U, a.run_id));
  eq(db._store.case_runs.length, 0, "自己刪不掉");
});

/* ═══ 清單 ═══ */

await t("清單分得清進行中與已封存，並帶出配額", async () => {
  const db = fakeDb() as any;
  const done = await endedRun(db, 71);
  await keepRun(db, U, done.run_id, true, "free");
  const live = payloadOf(await startCase(db, U, "huangcun", "lingshou", seeded(72)));

  const p = payloadOf(await listCases(db, U, "free"));
  eq(p.cases.length, 1, "目前只有一個案子");
  eq(p.cases[0].id, "huangcun", "案件 id 不對");
  eq(p.active.length, 1, "應有一局進行中");
  eq(p.active[0].run_id, live.run_id, "進行中那局不對");
  eq(p.kept.length, 1, "應有一份記憶檔案");
  eq(p.kept_quota, 1, "配額不對");
  ok(!JSON.stringify(p.cases).includes(HUANGCUN.truth.slice(0, 20)), "清單外流 truth");
});

console.log(`\n${pass} 過 / ${fail} 敗\n`);
process.exit(fail ? 1 : 0);
