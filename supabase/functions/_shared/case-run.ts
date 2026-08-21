// _shared/case-run.ts — 卦案存檔的伺服端服務層。
//
// 這一層是「進度與獎勵一律服務端判定」那條鐵則的落地處（同 0039_case_runs.sql）：
// 客戶端只送「我做了什麼」（一個 Action），伺服器自己重建盤面、自己算下一個狀態、
// 自己寫回 case_runs。前端送上來的 state 一律不看——它連欄位都不必送。
//
// 為什麼每次都重建而不快取盤面：projectCase() 是純函數，存檔只存起卦輸入
// （lines ＋ 進案年月日時），現算成本是幾十微秒，換來的是「投射邏輯一改，
// 舊存檔自動跟著新邏輯走」。存結果的話，每次調整投射就會把舊檔變成
// 一份再也重現不出來的髒資料——而你無從得知它是舊邏輯還是 bug。
//
// 另一件這一層在做的事：過濾。案件檔裡有 truth、brief、npc.voice、全部線索的
// 內文與去向；那些是「設計師寫死的世界」，玩家該一段一段挖出來，不是開局就
// 隨著第一包 JSON 全下發。下面每一支 payload 都是白名單挑欄位，不是整包丟出去——
// 反過來寫（挑掉敏感欄位）遲早會在新增欄位時漏一個，而漏了不會有任何徵兆。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildChart, castCoins } from "./core.ts";
import { projectCase, type CaseState } from "./case.ts";
import { toCaseDef, type CaseFile, type ClueFile } from "./case-schema.ts";
import {
  startRun, applyAction, options, regionView, review, clockOf,
  COMPANION_NAME, SOLVE_CLUE, type Action, type RunState,
} from "./case-engine.ts";
import { caseMenu, caseOf } from "./cases/index.ts";

// 台北時。pipeline.ts 有一支同樣的 nowTaipei()，這裡不 import 它——
// 那支模組在載入時就會讀 Deno.env（全站熔斷上限），把它拉進來會讓這一層
// 從「純邏輯＋db」變成「非 Deno 環境載不起來」，離線測試就跑不動了。
const TZ_OFFSET = 8;

/** 記憶檔案格數：免費 1、付費 3（剛好三個同行角色各一份）。
 *  滿格時由玩家主動捨棄，不自動覆蓋——自動洗掉的體感是刪檔。 */
export const keptQuota = (plan: string) => (plan === "free" ? 1 : 3);

export interface CaseRunRow {
  id: string;
  case_id: string;
  companion: string | null;
  lines: number[];
  entry_y: number; entry_m: number; entry_d: number; entry_hour: number | null;
  state: RunState;
  seq: number;
  ended: boolean; solved: boolean; kept: boolean;
  created_at: string; updated_at: string;
}

const ROW_COLS =
  "id, case_id, companion, lines, entry_y, entry_m, entry_d, entry_hour, state, seq, ended, solved, kept, created_at, updated_at";

/* ═══════════════ 重建 ═══════════════ */

export interface Rebuilt { cf: CaseFile; st: CaseState; run: RunState; row: CaseRunRow }

/** 存檔 → 可運算的三件組。案件檔查無、或存檔的 state 不成形，一律回 null 讓呼叫端回錯，
 *  不要在這裡自己補一個空 RunState——那會把「讀錯存檔」默默變成「開了一局新的」。 */
export function rebuild(row: CaseRunRow): Rebuilt | null {
  const cf = caseOf(row.case_id);
  if (!cf) return null;
  const run = row.state as RunState;
  if (!run || typeof run !== "object" || !Array.isArray(run.log)) return null;
  const chart = buildChart(row.lines, row.entry_y, row.entry_m, row.entry_d, row.entry_hour);
  const st = projectCase(chart, toCaseDef(cf));
  return { cf, st, run, row };
}

/* ═══════════════ 下發用 payload（白名單） ═══════════════ */

/** 卦盤。整份都是卦推出來的，沒有一項是案件內容——玩家本來就該讀得到，
 *  「用神落哪一區」正是卦替他縮小的範圍。只剔掉 sig（除錯用的指紋）。 */
function guaPayload(cf: CaseFile, st: CaseState) {
  const { sig: _sig, ...rest } = st;
  return { ...rest, map: cf.regions.map((r) => ({ pos: r.pos, name: r.name, image: r.image })) };
}

/** 當前區域。物件只出 id／名字／看過沒／擋住的理由——
 *  desc 是查看之後才進日誌的東西，obj.clue 更是直接指出「哪一個有料」。 */
function regionPayload(cf: CaseFile, st: CaseState, run: RunState) {
  const v = regionView(cf, st, run);
  return {
    pos: v.pos, name: v.name, image: v.image, dir: v.dir, beast: v.beast, mood: v.mood,
    paragraphs: v.paragraphs, roles: v.roles, searched: v.searched,
    objects: v.objects.map((o) => ({ id: o.obj.id, name: o.obj.name, seen: o.seen, blocked: o.blocked })),
    npcs: v.npcs,   // id／name／talked；voice 是給模型看的，不下發
  };
}

const cluePayload = (c: ClueFile) => ({ id: c.id, name: c.name, kind: c.kind, text: c.text, region: c.region });

/** 手上與已看出的。只出玩家真的拿到的那幾條，未取得者連 id 都不給。 */
function cluesPayload(cf: CaseFile, run: RunState) {
  const byId = new Map(cf.clues.map((c) => [c.id, c]));
  const got = run.clues.map((id) => byId.get(id)).filter((c): c is ClueFile => !!c);
  return {
    held: got.filter((c) => c.kind === "item").map(cluePayload),
    known: got.filter((c) => c.kind === "knowledge").map(cluePayload),
    // 分母：知識類線索總數。原型就顯示「已看出 n／N」，屬於已公開的進度尺。
    known_total: cf.clues.filter((c) => c.kind === "knowledge").length,
  };
}

/** 結案回顧。未發現者只回數量——回名字等於把沒挖到的東西免費送給玩家；
 *  truth 只在 truthShown 時才附，這是整份案件檔最不能提早外流的一段。 */
function reviewPayload(cf: CaseFile, st: CaseState, run: RunState) {
  const rv = review(cf, st, run);
  return {
    title: rv.title, spent: rv.spent, clock: rv.clock, solved: rv.solved,
    companion: rv.companion, companion_finds: rv.companionFinds, companion_total: rv.companionTotal,
    found: rv.found.map(cluePayload),
    lost: rv.lost.map((c) => ({ id: c.id, name: c.name })),
    missed_count: rv.missed.length,
    gua: rv.gua,
    truth: rv.truthShown ? cf.truth : null,
  };
}

/** 一局的完整畫面。前端每次行動後照這一包重畫，不必自己維護任何局內狀態。 */
export function runPayload({ cf, st, run, row }: Rebuilt) {
  return {
    run_id: row.id,
    case_id: cf.id,
    title: cf.title,
    question: cf.question,
    companion: run.companion,
    companion_name: run.companion ? COMPANION_NAME[run.companion] ?? run.companion : null,
    minute: run.minute,
    clock: clockOf(run.minute),
    spent: run.minute - run.startMinute,
    ended: run.ended,
    kept: row.kept,
    errand: run.errand
      ? {
        // 去了哪一區只有他自己說了才算數（told）——不知道他在哪，玩家才會猶豫要不要自己也去。
        region: run.errand.told ? run.errand.region : null,
        minutes_left: Math.max(0, run.errand.returnAt - run.minute),
      }
      : null,
    gua: guaPayload(cf, st),
    region: run.ended ? null : regionPayload(cf, st, run),
    options: run.ended ? [] : options(cf, st, run).map((o) => ({
      action: o.action, label: o.label, cost: o.cost, note: o.note ?? null,
    })),
    clues: cluesPayload(cf, run),
    log: run.log,
    review: run.ended ? reviewPayload(cf, st, run) : null,
  };
}

/* ═══════════════ 讀取 ═══════════════ */

async function loadRow(db: SupabaseClient, uid: string, runId: string): Promise<CaseRunRow | null> {
  // 綁 user_id 一起查：拿到別人的 run_id 也讀不到別人的存檔。
  const { data } = await db.from("case_runs").select(ROW_COLS)
    .eq("id", runId).eq("user_id", uid).maybeSingle();
  return (data as CaseRunRow | null) ?? null;
}

async function loadActive(db: SupabaseClient, uid: string, caseId: string): Promise<CaseRunRow | null> {
  const { data } = await db.from("case_runs").select(ROW_COLS)
    .eq("user_id", uid).eq("case_id", caseId).eq("ended", false).maybeSingle();
  return (data as CaseRunRow | null) ?? null;
}

export type CaseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

/** 清單：可玩的案子、進行中的局、已封存的記憶檔案（含配額）。
 *
 *  刻意分成兩支窄查詢，而不是「拿這個人的存檔前 50 筆再自己分類」：
 *  state 那一欄裝著整局的行動日誌，一局玩到底可以是好幾十 KB。
 *  進行中的局最多一案一局、記憶檔案最多三份——照條件各撈各的，
 *  這支 API 的體積就跟玩了多久無關。 */
export async function listCases(db: SupabaseClient, uid: string, plan: string): Promise<CaseResult> {
  const pick = async (col: "ended" | "kept", val: boolean) => {
    const { data } = await db.from("case_runs")
      .select("id, case_id, companion, state, ended, solved, kept, created_at, updated_at")
      .eq("user_id", uid).eq(col, val).order("created_at", { ascending: false }).limit(20);
    return (data ?? []) as CaseRunRow[];
  };
  const [active, kept] = await Promise.all([pick("ended", false), pick("kept", true)]);

  // 摘要只出「進行到哪」，不出走到哪、拿到哪幾條——那些要進案才看得到。
  const brief = (r: CaseRunRow) => ({
    run_id: r.id, case_id: r.case_id, title: caseOf(r.case_id)?.title ?? r.case_id,
    companion: r.companion,
    companion_name: r.companion ? COMPANION_NAME[r.companion] ?? r.companion : null,
    clock: clockOf(r.state?.minute ?? 0),
    clues: r.state?.clues?.length ?? 0,
    ended: r.ended, solved: r.solved, kept: r.kept,
    created_at: r.created_at, updated_at: r.updated_at,
  });

  return {
    ok: true,
    payload: {
      cases: caseMenu(),
      active: active.map(brief),
      kept: kept.map(brief),
      kept_quota: keptQuota(plan),
    },
  };
}

/* ═══════════════ 進案 ═══════════════ */

/** 起卦並開局，一次做完。
 *
 *  起卦擲在伺服器，不收前端送來的 lines：卦決定關鍵線索的取得代價（access），
 *  由客戶端擲就等於讓玩家自己選難度。同理沒有「重新起卦」——原型有那顆鈕是
 *  除錯用的，照搬上線等於玩家可以一直重擲到 open 為止，代價機制當場作廢。
 *  要換一支卦，就得把這一局收掉（結案），那是有代價的。
 *
 *  同一人同一案只准有一局進行中，由 0039 的唯一索引 case_runs_one_active 仲裁；
 *  這裡先查一次是為了回一個看得懂的訊息，真正的把關在資料庫那一層（併發下先查後寫
 *  仍會撞在一起，撞了就吃 23505，照樣不會開出兩局）。
 */
export async function startCase(
  db: SupabaseClient, uid: string, caseId: unknown, companion: unknown, rng: () => number = Math.random,
): Promise<CaseResult> {
  const cf = caseOf(caseId);
  if (!cf) return { ok: false, msg: "查無此案" };

  const comp = companion == null || companion === "" ? null : String(companion);
  if (comp && !cf.companions.some((c) => c.id === comp)) return { ok: false, msg: "此案沒有這位同行" };

  const existing = await loadActive(db, uid, cf.id);
  if (existing) {
    const rb = rebuild(existing);
    if (!rb) return { ok: false, msg: "存檔讀不回來" };
    return { ok: true, payload: { resumed: true, ...runPayload(rb) } };
  }

  const now = new Date(Date.now() + TZ_OFFSET * 3600_000);
  const hour = cf.entryHour ?? now.getUTCHours();
  const { lines } = castCoins(rng);
  const entry = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate(), hour };

  const chart = buildChart(lines, entry.y, entry.m, entry.d, entry.hour);
  const st = projectCase(chart, toCaseDef(cf));
  const run = startRun(cf, st, comp);

  const { data, error } = await db.from("case_runs").insert({
    user_id: uid, case_id: cf.id, companion: comp,
    lines, entry_y: entry.y, entry_m: entry.m, entry_d: entry.d, entry_hour: entry.hour,
    state: run, seq: 0, ended: false, solved: false, kept: false,
  }).select(ROW_COLS).single();

  if (error || !data) {
    // 23505＝撞上 case_runs_one_active：同一瞬間開了兩局，另一局先寫成功了。
    // 這不是錯誤，是約束正確地擋下重複，把先寫成的那一局讀回來給他。
    if ((error as { code?: string } | null)?.code === "23505") {
      const row = await loadActive(db, uid, cf.id);
      const rb = row && rebuild(row);
      if (rb) return { ok: true, payload: { resumed: true, ...runPayload(rb) } };
    }
    console.error("case_start insert failed", error);
    return { ok: false, msg: "進案失敗" };
  }
  return { ok: true, payload: { resumed: false, ...runPayload(rebuild(data as CaseRunRow)!) } };
}

/* ═══════════════ 讀檔 ═══════════════ */

export async function caseStateOf(db: SupabaseClient, uid: string, runId: unknown): Promise<CaseResult> {
  const row = await loadRow(db, uid, String(runId ?? ""));
  if (!row) return { ok: false, msg: "查無此存檔" };
  const rb = rebuild(row);
  if (!rb) return { ok: false, msg: "存檔讀不回來" };
  return { ok: true, payload: runPayload(rb) };
}

/* ═══════════════ 行動 ═══════════════ */

/** 前端送上來的東西 → Action。認不得的一律 null，不猜。 */
export function parseAction(a: unknown): Action | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  switch (o.kind) {
    case "move": return Number.isInteger(o.to) ? { kind: "move", to: o.to as number } : null;
    case "search": return { kind: "search" };
    case "inspect": return typeof o.objectId === "string" ? { kind: "inspect", objectId: o.objectId } : null;
    case "talk": return typeof o.npcId === "string" ? { kind: "talk", npcId: o.npcId } : null;
    case "companion": return { kind: "companion" };
    case "end": return { kind: "end" };
    default: return null;
  }
}

/** 這個行動此刻是否真的擺在他面前。
 *
 *  比對 options() 而不是各自寫一份條件：那份清單就是「現在能做什麼」的唯一定義，
 *  另寫一套驗證等於維護兩份會慢慢分岔的規則。少了這一關，前端可以查看不在這一區的
 *  物件、走到不存在的區、在同行外出時再拜託他一次——applyAction 對其中幾種會靜靜地
 *  什麼都不做，於是玩家看到的是「點了沒反應」，而不是「這件事現在做不到」。 */
function matchOption(cf: CaseFile, st: CaseState, run: RunState, a: Action) {
  return options(cf, st, run).find((o) => {
    if (o.action.kind !== a.kind) return false;
    if (a.kind === "move") return (o.action as { to: number }).to === a.to;
    if (a.kind === "inspect") return (o.action as { objectId: string }).objectId === a.objectId;
    if (a.kind === "talk") return (o.action as { npcId: string }).npcId === a.npcId;
    return true;
  }) ?? null;
}

export async function actOnCase(
  db: SupabaseClient, uid: string, runId: unknown, rawAction: unknown,
): Promise<CaseResult> {
  const row = await loadRow(db, uid, String(runId ?? ""));
  if (!row) return { ok: false, msg: "查無此存檔" };
  if (row.ended) return { ok: false, msg: "這一局已經結案了" };
  const rb = rebuild(row);
  if (!rb) return { ok: false, msg: "存檔讀不回來" };

  const action = parseAction(rawAction);
  if (!action) return { ok: false, msg: "認不得這個行動" };
  if (!matchOption(rb.cf, rb.st, rb.run, action)) return { ok: false, msg: "此刻做不到這件事" };

  const next = applyAction(rb.cf, rb.st, rb.run, action);
  // solved 抽成獨立欄位而不是每次讀檔重算：它要能被 SQL 查（統計、成就、下次進案加成），
  // 而 state 裡那包 jsonb 查得到但查得很難看。SOLVE_CLUE 目前是引擎裡寫死的單一線索，
  // 案件一多就得升成案件檔欄位——屆時只有這一行要改。
  const solved = next.clues.includes(SOLVE_CLUE);

  // 樂觀鎖：這一包是根據第 row.seq 號狀態算出來的，就只准蓋在第 row.seq 號上。
  // 少了它，兩個同時在飛的行動會各自從同一份舊狀態算起，後寫的那個把先寫的整包蓋掉
  // ——玩家看到的是「我剛剛明明搜過了」。ended=false 同時擋住對已結案存檔的寫入。
  // updated_at 由 0039 的 trigger 維護，不在這裡帶。
  const { data, error } = await db.from("case_runs")
    .update({ state: next, seq: row.seq + 1, ended: next.ended, solved })
    .eq("id", row.id).eq("user_id", uid).eq("ended", false).eq("seq", row.seq)
    .select(ROW_COLS).maybeSingle();
  if (error) { console.error("case_action update failed", error); return { ok: false, msg: "存檔寫入失敗" }; }
  if (!data) {
    // 沒更新到列有兩種可能，回訊息前先分辨：這一局結案了，還是被另一個請求搶先寫了。
    const now = await loadRow(db, uid, row.id);
    if (!now) return { ok: false, msg: "查無此存檔" };
    if (now.ended) return { ok: false, msg: "這一局已經結案了" };
    return { ok: false, msg: "動作重疊了，請再試一次" };
  }

  return { ok: true, payload: runPayload(rebuild(data as CaseRunRow)!) };
}

/* ═══════════════ 記憶檔案 ═══════════════ */

/** 封存／取消封存。配額滿時回明確訊息，由玩家自己去捨棄哪一份——不自動覆蓋。 */
export async function keepRun(
  db: SupabaseClient, uid: string, runId: unknown, keep: boolean, plan: string,
): Promise<CaseResult> {
  const row = await loadRow(db, uid, String(runId ?? ""));
  if (!row) return { ok: false, msg: "查無此存檔" };
  if (keep && !row.ended) return { ok: false, msg: "這一局還沒結案" };

  if (keep && !row.kept) {
    const quota = keptQuota(plan);
    const { count } = await db.from("case_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("kept", true);
    if ((count ?? 0) >= quota) {
      return { ok: false, msg: `記憶檔案已滿（${quota} 格）。要留這一份，得先捨棄一份舊的。` };
    }
  }

  const { error } = await db.from("case_runs").update({ kept: keep }).eq("id", row.id).eq("user_id", uid);
  if (error) { console.error("case_keep update failed", error); return { ok: false, msg: "存檔寫入失敗" }; }
  return { ok: true, payload: { run_id: row.id, kept: keep, kept_quota: keptQuota(plan) } };
}

/** 捨棄存檔。封存過的也能刪——配額滿了要換掉哪一份是玩家的決定。
 *
 *  只刪得掉已結案的。進行中的局若刪得掉，那就是一條繞過「不能重新起卦」的路：
 *  進案 → 看到卦不合意 → 刪掉 → 再進案，重擲到滿意為止，代價機制照樣作廢。
 *  要放掉一局就結案，那一局會照實記成「沒破案」——那才是它的代價。 */
export async function deleteRun(db: SupabaseClient, uid: string, runId: unknown): Promise<CaseResult> {
  const id = String(runId ?? "");
  const row = await loadRow(db, uid, id);
  if (!row) return { ok: false, msg: "查無此存檔" };
  if (!row.ended) return { ok: false, msg: "這一局還沒結案，要放掉就先結案" };
  const { error } = await db.from("case_runs").delete().eq("id", id).eq("user_id", uid);
  if (error) { console.error("case_delete failed", error); return { ok: false, msg: "刪除失敗" }; }
  return { ok: true, payload: { run_id: id, deleted: true } };
}
