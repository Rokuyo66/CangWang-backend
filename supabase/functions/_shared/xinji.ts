// _shared/xinji.ts — 心跡：一件事的一條線。
//
// 這一層的存在理由，用一句話講：問卦每一卦都是孤島，而閒聊不是。
// 閒聊有 character_memories、有卦曆注入、有好感，所以人會在那裡停下來；
// 起卦問完就結束，下次再問同一件事，pipeline 的一事不二占還會擋他一下。
// 心跡把「同一件事問很多次」從違規翻成主線。
//
// 【成本紀律】這一層預設零 AI。時間軸、溫度線、角色留言、月誌的統計，
// 全部是查詢與純計算。整支檔案只有一處呼叫模型：月誌卷首語，每人每月一次、走 haiku。
// 這不是省小錢的潔癖——0043 量出來的實數是起卦 0.70 元、追問 0.64 元一次，
// 而心跡要的是「每天打開都有東西看」。每天都有東西看又每次都要付錢的功能，撐不住。
//
// 【現算不快取】溫度線與月誌統計都不落快照，理由與 case-run.ts 每次重建盤面同一條：
// 回評會遲到（三月的卦，人四月才回報），存快照那一列從此與事實不符，
// 而你無從得知它是舊資料還是 bug。唯一存起來的是卷首語——那是 AI 生成的，
// 重跑一次就是重新付一次錢，而且會變成另一段話。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { monthWang, type Wang } from "./case.ts";
import { FORTUNE_CATEGORY, normalizeQuestion } from "./rules.ts";

// 台北日界。services.ts 有一支同樣的 taipeiToday()，這裡不 import 它——
// 那支模組在載入時就會讀 Deno.env（額度、模型名、金鑰），把它拉進來會讓這一層
// 從「純邏輯＋db」變成「非 Deno 環境載不起來」，離線測試就跑不動了。
// 同一個取捨 case-run.ts 已經做過一次（見其檔頭的 nowTaipei）。
const taipeiToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export type XinjiResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; msg: string };

const err = (msg: string): XinjiResult => ({ ok: false, msg });
const ok = (payload: Record<string, unknown>): XinjiResult => ({ ok: true, payload });

/* ═══════════════ 額度 ═══════════════ */

/** 同時「在記」幾件事。額度不落資料——查詢時判，所以升降方案立即生效。
 *  免費 1 件是刻意的：它足以讓人體會「被記著」是什麼感覺，而第二件事就是付費點。
 *  已了結的不佔額度（了結是好事，不該罰）。 */
export const PLAN_THREADS: Record<string, number> = { free: 1, guanwei: 3, zhiji: 8, cangwang: 20 };
export const threadQuotaOf = (plan: string) => PLAN_THREADS[plan] ?? PLAN_THREADS.free;

/** 一條心事多久沒動，就算「擱著」。角色會為此留一句話。 */
const QUIET_DAYS = 10;

/* ═══════════════ 型別 ═══════════════ */

interface ThreadRow {
  id: string; user_id: string; title: string; subject: string | null;
  category: string | null; question_norm: string | null;
  status: string; opened_at: string; closed_at: string | null; last_cast_at: string | null;
}

interface CastRow {
  id: string; question: string | null; digest: string | null; reading: string | null;
  gua_ben: string; gua_bian: string | null; chart: unknown;
  character_id: string | null; category: string | null;
  yong_qin: string | null; yong_via_shi: boolean | null;
  due_date: string | null; created_at: string;
}

const THREAD_COLS =
  "id, user_id, title, subject, category, question_norm, status, opened_at, closed_at, last_cast_at";
const CAST_COLS =
  "id, question, digest, reading, gua_ben, gua_bian, chart, character_id, category, " +
  "yong_qin, yong_via_shi, due_date, created_at";

/* ═══════════════ 溫度線 ═══════════════ */

/** 旺相休囚死 → 0..4。畫線要有序數，而「旺」在最上面。 */
const WANG_SCORE: Record<Wang, number> = { 死: 0, 囚: 1, 休: 2, 相: 3, 旺: 4 };

/** 一卦的用神旺衰。
 *
 *  用神取法沿用該卦當時取定的（casts.yong_qin／yong_via_shi）——那是解卦當下
 *  依所問之事落定的，事後另取一個會讓同一條線前後不同基準，畫出來的起伏是假的。
 *  沒取定的舊卦退回世爻（＝問自身），並在回傳標明 basis，前端才說得出這條線的依據。
 *
 *  只取月令旺衰（rules.ts 第 33 行的第一層），不進日辰生剋沖合。
 *  理由：這條線要跨月比較，日辰是當天的偶然，月令才是那段時間的底氣；
 *  而且它是「趨勢」不是「斷語」，多算一層並不會讓它更誠實，只會讓它更像在解卦。 */
function wangOfCast(c: CastRow): { wang: Wang; score: number; basis: string } | null {
  const chart = c.chart as {
    ben?: { zhi: string; wx: string; qin: string }[];
    fushen?: { wx: string; qin: string }[];
    shi?: number;
    ganzhi?: { month?: string };
  } | null;
  const monZhi = chart?.ganzhi?.month?.slice(-1);
  if (!monZhi || !Array.isArray(chart?.ben) || !chart.ben.length) return null;

  let yao: { wx: string } | undefined;
  let basis: string;
  if (c.yong_via_shi || !c.yong_qin) {
    yao = chart.ben[(chart.shi ?? 1) - 1];
    basis = c.yong_via_shi ? "世爻" : "世爻（此卦未取定用神）";
  } else {
    yao = chart.ben.find((e) => e.qin === c.yong_qin)
      ?? (chart.fushen ?? []).find((e) => e.qin === c.yong_qin);
    basis = c.yong_qin + (chart.ben.some((e) => e.qin === c.yong_qin) ? "" : "（伏神）");
  }
  if (!yao?.wx) return null;
  const wang = monthWang(yao.wx, monZhi);
  return { wang, score: WANG_SCORE[wang], basis };
}

/* ═══════════════ 角色留言（零 AI） ═══════════════ */
//
// 句庫寫死。這不是偷懶——留言每天都可能發生，用模型生成等於把最日常的動作
// 綁上最貴的成本。而且這幾句的品質，寫死的一定比 haiku 即興的穩。
//
// 稱謂依 0001／0005 的人設：大師兄稱「護道人」、師妹稱「施主」、觀喵稱「鏟屎的」。
// 觀喵的旁白依 0014 用全形星號包住並以第三人稱寫（chat.ts 的 normalizeNarration
// 是給模型輸出擦屁股的，寫死的句子本來就該寫對）。

type NoteKind = "due_passed" | "gone_quiet" | "closed";

const NOTE_POOL: Record<string, Record<NoteKind, string[]>> = {
  daoshi_m: {
    due_passed: [
      "「{title}的應期已過。結果如何，護道人。」",
      "＊大師兄把那張卦紙抽出來，壓在案角＊\n\n「{title}。應期到了。」",
    ],
    gone_quiet: [
      "「{title}擱了{days}日。是了了，還是不想提。」",
      "「{title}沒有下文。護道人自己清楚是哪一種。」",
    ],
    closed: [
      "「{title}記結了。這一件，你走得不算慢。」",
    ],
  },
  daoshi_f: {
    due_passed: [
      "「施主，{title}那件事的應期到了——後來怎麼樣了？」",
      "＊師妹翻開冊子，指尖停在那一行＊\n\n「{title}。可以跟我說說後來嗎？」",
    ],
    gone_quiet: [
      "「{title}好一陣子沒動靜了。還在心上嗎？」",
      "「{days}天了。施主是放下了，還是只是不想看。」",
    ],
    closed: [
      "「{title}總算了了。施主這回，撐得比自己以為的久。」",
    ],
  },
  lingshou: {
    due_passed: [
      "＊觀喵甩了甩尾巴＊\n\n「上次你問{subject}那件事，後來呢？」",
      "「{title}。日子到了。鏟屎的，別裝沒看見。」",
    ],
    gone_quiet: [
      "「{title}？你自己記不記得還有這回事。」",
      "＊觀喵舔了舔爪子＊\n\n「擱了{days}天。哦。」",
    ],
    closed: [
      "＊觀喵打了個哈欠＊\n\n「哦，你居然真的把它問完了。」",
    ],
  },
};

/** 從句庫挑一句：以 dedupe_key 做確定性選擇。
 *  用亂數的話，同一則留言若因任何原因被重算，文字就會變——而它已經被人看過了。 */
function pickLine(pool: string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return pool[Math.abs(h) % pool.length];
}

const fillLine = (tpl: string, v: Record<string, string>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

/** 台北日界下的兩個日期差幾天 */
const daysBetween = (a: string | null | undefined, b: string | null | undefined) => {
  const x = Date.parse(a ?? ""), y = Date.parse(b ?? "");
  // 一列的日期壞掉，不該讓整個時間軸打不開——與月誌生成失敗照給統計同一條原則
  return Number.isNaN(x) || Number.isNaN(y) ? 0 : Math.round((y - x) / 86400_000);
};

/**
 * 熬留言。在每次開心跡時順手跑一遍，零 AI、零外呼。
 *
 * 三個條件，都是「這件事真的發生了」才成立，不是為了有東西顯示而硬擠：
 *   due_passed  應期過了、還沒回評 → 問他後來呢
 *   gone_quiet  在記的事擱了 QUIET_DAYS 天沒新卦 → 問他還在不在意
 *   closed      剛了結 → 說一句
 *
 * 不重複由 thread_notes 的唯一索引保證（見 0045）。這裡照樣先查一次再寫，
 * 純粹是為了少打幾次注定失敗的 insert；真正的保證在資料庫，不在這幾行。
 */
export async function brewNotes(db: SupabaseClient, uid: string): Promise<number> {
  const today = taipeiToday();

  const { data: rows } = await db.from("threads").select(THREAD_COLS)
    .eq("user_id", uid).order("last_cast_at", { ascending: false, nullsFirst: false }).limit(50);
  const threads = (rows ?? []) as ThreadRow[];
  if (!threads.length) return 0;

  // 一次撈齊這些心事的最後一卦與其回評，別在迴圈裡逐條打 DB
  const ids = threads.map((t) => t.id);
  const { data: castRows } = await db.from("casts")
    .select("id, thread_id, character_id, due_date, created_at, feedback(verdict)")
    .in("thread_id", ids).order("created_at", { ascending: false });
  const casts = (castRows ?? []) as {
    id: string; thread_id: string; character_id: string | null;
    due_date: string | null; created_at: string;
    feedback: { verdict: number | null } | { verdict: number | null }[] | null;
  }[];

  const latest = new Map<string, typeof casts[number]>();
  for (const c of casts) if (!latest.has(c.thread_id)) latest.set(c.thread_id, c);

  const verdictOf = (c: typeof casts[number]) => {
    const f = Array.isArray(c.feedback) ? c.feedback[0] : c.feedback;
    return f?.verdict ?? null;
  };

  const pending: {
    user_id: string; thread_id: string; character_id: string; kind: NoteKind;
    body: string; cast_id: string | null; dedupe_key: string;
  }[] = [];

  for (const t of threads) {
    const last = latest.get(t.id);
    // 說話的是這條線上最後一卦的那位角色。沒有卦就沒有角色，也就沒有立場說話。
    const who = last?.character_id;
    if (!who || !NOTE_POOL[who]) continue;

    const vars = { title: t.title, subject: t.subject ?? t.title, days: "" };

    if (t.status === "closed" && t.closed_at) {
      const key = `closed:${t.id}`;
      pending.push({
        user_id: uid, thread_id: t.id, character_id: who, kind: "closed",
        body: fillLine(pickLine(NOTE_POOL[who].closed, key), vars),
        cast_id: last.id, dedupe_key: key,
      });
      continue;
    }
    if (t.status !== "open") continue;

    // 應期到了沒回報。以最後一卦的應期為準——早先幾卦的應期若沒回，
    // 那條提醒在它自己到期時就發過了。
    if (last.due_date && last.due_date <= today && !verdictOf(last)) {
      const key = `due:${t.id}:${last.due_date}`;
      pending.push({
        user_id: uid, thread_id: t.id, character_id: who, kind: "due_passed",
        body: fillLine(pickLine(NOTE_POOL[who].due_passed, key), vars),
        cast_id: last.id, dedupe_key: key,
      });
      continue; // 一條線一次只說一句，不疊著念
    }

    // 擱著了。dedupe_key 帶「第幾個十天」，所以同一條線擱久了會再念一次，
    // 但不會天天念——鍵一週只換一次的話，久擱的線就永遠只念一次，那是另一種失聯。
    const since = last.created_at.slice(0, 10);
    const quiet = daysBetween(since, today);
    if (quiet >= QUIET_DAYS) {
      const key = `quiet:${t.id}:${Math.floor(quiet / QUIET_DAYS)}`;
      vars.days = String(quiet);
      pending.push({
        user_id: uid, thread_id: t.id, character_id: who, kind: "gone_quiet",
        body: fillLine(pickLine(NOTE_POOL[who].gone_quiet, key), vars),
        cast_id: last.id, dedupe_key: key,
      });
    }
  }

  if (!pending.length) return 0;
  const { data: existing } = await db.from("thread_notes").select("dedupe_key")
    .eq("user_id", uid).in("dedupe_key", pending.map((p) => p.dedupe_key));
  const have = new Set((existing ?? []).map((r) => (r as { dedupe_key: string }).dedupe_key));
  const fresh = pending.filter((p) => !have.has(p.dedupe_key));
  if (!fresh.length) return 0;

  // ignoreDuplicates：兩個裝置同時開心跡也只會留下一則
  const { error } = await db.from("thread_notes").upsert(fresh, {
    onConflict: "user_id,dedupe_key", ignoreDuplicates: true,
  });
  if (error) { console.error("brewNotes insert failed", error); return 0; }
  return fresh.length;
}

/* ═══════════════ 時間軸 ═══════════════ */

/** 心跡首頁。開頁時先熬一次留言，再一次把畫面要的東西全撈回去。 */
export async function timeline(db: SupabaseClient, uid: string, plan: string): Promise<XinjiResult> {
  await brewNotes(db, uid);
  const today = taipeiToday();

  const { data: rows, error } = await db.from("threads").select(THREAD_COLS)
    .eq("user_id", uid)
    // 「在記的在前」不能靠 order("status")——字串升冪是 closed < open，
    // 已了結的反而會排到最上面（而且看起來很像有在排序，所以不會有人發現）。
    // 改用 closed_at：在記的那些它是 null，nullsFirst 讓它們穩穩在前，
    // 已了結的再照結案時間新到舊。這是語意，不是字母順序的巧合。
    .order("closed_at", { ascending: false, nullsFirst: true })
    .order("last_cast_at", { ascending: false, nullsFirst: false })
    .limit(60);
  if (error) { console.error("timeline threads failed", error); return err("心跡讀不回來"); }
  const threads = (rows ?? []) as ThreadRow[];

  const ids = threads.map((t) => t.id);
  const byThread = new Map<string, { casts: number; last: CastRow | null; verdict: number | null }>();
  if (ids.length) {
    const { data: cs } = await db.from("casts")
      .select("id, thread_id, question, digest, gua_ben, character_id, due_date, created_at, feedback(verdict)")
      .in("thread_id", ids).order("created_at", { ascending: false });
    for (const raw of (cs ?? []) as (CastRow & { thread_id: string; feedback: unknown })[]) {
      const slot = byThread.get(raw.thread_id) ?? { casts: 0, last: null, verdict: null };
      slot.casts++;
      if (!slot.last) {
        slot.last = raw;
        const f = Array.isArray(raw.feedback) ? raw.feedback[0] : raw.feedback;
        slot.verdict = (f as { verdict: number | null } | null)?.verdict ?? null;
      }
      byThread.set(raw.thread_id, slot);
    }
  }

  const { data: noteRows } = await db.from("thread_notes")
    .select("id, thread_id, character_id, kind, body, cast_id, created_at, read_at, replied_at")
    .eq("user_id", uid).is("replied_at", null)
    .order("created_at", { ascending: false }).limit(12);

  const open = threads.filter((t) => t.status === "open");
  const view = (t: ThreadRow) => {
    const s = byThread.get(t.id);
    const last = s?.last;
    const due = last?.due_date ?? null;
    return {
      id: t.id, title: t.title, subject: t.subject, category: t.category,
      status: t.status,
      cast_count: s?.casts ?? 0,
      opened_at: t.opened_at, closed_at: t.closed_at,
      days: daysBetween(t.opened_at.slice(0, 10), (t.closed_at ?? new Date().toISOString()).slice(0, 10)),
      last_gua: last?.gua_ben ?? null,
      last_digest: last?.digest ?? null,
      last_character: last?.character_id ?? null,
      due_date: due,
      // 負數＝已過。前端照這個數字寫「還有 N 日」或「已過 N 日」，不必自己算日界。
      due_in: due ? daysBetween(today, due) : null,
      due_answered: s?.verdict != null,
      verdict: s?.verdict ?? null,
    };
  };

  return ok({
    threads: threads.map(view),
    notes: noteRows ?? [],
    quota: { open: open.length, max: threadQuotaOf(plan) },
  });
}

/* ═══════════════ 單一心事 ═══════════════ */

export async function threadDetail(db: SupabaseClient, uid: string, threadId: unknown): Promise<XinjiResult> {
  const id = String(threadId ?? "");
  if (!id) return err("缺心事");
  const { data: t } = await db.from("threads").select(THREAD_COLS)
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!t) return err("查無此心事");
  const th = t as ThreadRow;

  const { data: cs } = await db.from("casts").select(CAST_COLS + ", feedback(verdict, note)")
    .eq("thread_id", id).eq("user_id", uid).order("created_at", { ascending: true });
  const casts = (cs ?? []) as (CastRow & { feedback: unknown })[];

  // 溫度線：一卦一點。算不出來的卦（舊資料 chart 不成形）跳過而不補零——
  // 補零會在圖上畫出一段根本沒發生過的暴跌。
  const temp = casts.map((c) => {
    const w = wangOfCast(c);
    return w && {
      cast_id: c.id, at: c.created_at, gua: c.gua_ben,
      wang: w.wang, score: w.score, basis: w.basis,
    };
  }).filter(Boolean);

  const verdictOf = (c: { feedback: unknown }) => {
    const f = Array.isArray(c.feedback) ? c.feedback[0] : c.feedback;
    return (f ?? null) as { verdict: number | null; note: string | null } | null;
  };

  return ok({
    thread: {
      id: th.id, title: th.title, subject: th.subject, category: th.category,
      status: th.status, opened_at: th.opened_at, closed_at: th.closed_at,
      cast_count: casts.length,
      days: daysBetween(th.opened_at.slice(0, 10), (th.closed_at ?? new Date().toISOString()).slice(0, 10)),
    },
    casts: casts.map((c) => {
      const f = verdictOf(c);
      return {
        id: c.id, at: c.created_at, question: c.question,
        gua_ben: c.gua_ben, gua_bian: c.gua_bian,
        digest: c.digest, character_id: c.character_id,
        due_date: c.due_date, verdict: f?.verdict ?? null, verdict_note: f?.note ?? null,
      };
    }),
    // 前端照 score（0..4）畫縱軸，照 wang 印字。basis 要顯示出來——
    // 這條線的依據是什麼，不該讓人猜。
    temperature: { points: temp, levels: ["死", "囚", "休", "相", "旺"] },
  });
}

/* ═══════════════ 開／關／歸線 ═══════════════ */

/** 起新心事。可帶一張既有的卦當首卦（從卦曆或剛解完的卦進來）。
 *
 *  也可以完全沒有卦——從閒聊進來就是這一種：話已經聊到某件事上，卦還沒起。
 *  那時帶的是 `question`（角色替他理好的那一句，拿去算 question_norm，
 *  之後那一卦才認得出該歸這條線）與 `note`（一句話總結，落成這條線的第一則留言）。
 *
 *  【為什麼總結要落成留言，而不是塞進 title】
 *  title 是這件事的名字（「那筆尾款」），要短、要能在時間軸上一眼掃過。
 *  總結是「當時到底怎麼回事」，那是內容。混在一起的話，時間軸會變成一列長句子，
 *  而心跡首頁的價值正在於一眼看得完。 */
export async function openThread(
  db: SupabaseClient, uid: string, plan: string,
  p: {
    title?: unknown; subject?: unknown; category?: unknown; castId?: unknown;
    question?: unknown; note?: unknown; characterId?: unknown;
  },
): Promise<XinjiResult> {
  const title = String(p.title ?? "").trim().slice(0, 40);
  if (!title) return err("這件事總得有個名字");

  const { count } = await db.from("threads").select("id", { count: "exact", head: true })
    .eq("user_id", uid).eq("status", "open");
  const max = threadQuotaOf(plan);
  if ((count ?? 0) >= max) {
    return err(max === 1
      ? "心跡同時只記得住一件事。要記新的，得先了結手上那一件——或持玉牒入觀，多幾格。"
      : `心跡同時記 ${max} 件事已滿。先了結一件，再記新的。`);
  }

  let first: CastRow | null = null;
  if (p.castId) {
    const { data } = await db.from("casts").select(CAST_COLS + ", thread_id")
      .eq("id", String(p.castId)).eq("user_id", uid).maybeSingle();
    if (!data) return err("查無此卦");
    if ((data as { category: string | null }).category === FORTUNE_CATEGORY)
      return err("日運不是問事，記不成一件心事");
    if ((data as { thread_id: string | null }).thread_id) return err("這一卦已經在另一條線上了");
    first = data as CastRow;
  }

  const { data: row, error } = await db.from("threads").insert({
    user_id: uid, title,
    subject: p.subject ? String(p.subject).trim().slice(0, 30) : null,
    category: p.category ? String(p.category).slice(0, 8) : first?.category ?? null,
    // 首卦問句的正規化形。從閒聊進來時還沒有卦，用角色擬好的那一句頂上——
    // 沒有它，等他真的去起卦，一事不二占會把他擋在門外，而他前一步才剛把
    // 這件事記進心跡。那是整條路上最傷的一種擋法。
    question_norm: first?.question
      ? normalizeQuestion(first.question)
      : (p.question ? normalizeQuestion(String(p.question)) || null : null),
    // status 與 opened_at 明確寫入，不靠 DB 預設值。
    // setThreadStatus 寫 status 是明寫的，這裡靠 default，等於同一欄兩套規矩；
    // 而額度、時間軸、brewNotes、suggestThread 全都 filter status——
    // 寫入端少說一句，讀取端就整排對不上，而且不會報錯，只會是空的。
    status: "open",
    opened_at: new Date().toISOString(),
    last_cast_at: first?.created_at ?? null,
  }).select(THREAD_COLS).single();
  if (error) { console.error("openThread failed", error); return err("記不下來，稍後再試"); }

  const thread = row as ThreadRow;
  if (first) await db.from("casts").update({ thread_id: thread.id }).eq("id", first.id);

  // 從閒聊進來的第一則留言＝那段話的總結。用留言而不是另開一張表：
  // 心跡的角色留言本來就是「這條線上有人說了句話」，來源是熬出來的還是聊出來的
  // 不該讓畫面多長一種東西出來。dedupe_key 讓它一條線只落一次。
  const note = String(p.note ?? "").trim().slice(0, 120);
  const who = String(p.characterId ?? "").trim();
  if (note && who) {
    const { error: nErr } = await db.from("thread_notes").upsert({
      user_id: uid, thread_id: thread.id, character_id: who, kind: "from_chat",
      body: note, cast_id: null, dedupe_key: `chat:${thread.id}`,
    }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
    // 留言掉了不該讓「記下這件事」整支失敗——線已經開了，那才是他要的
    if (nErr) console.error("openThread note failed", nErr);
  }

  return ok({ thread, quota: { open: (count ?? 0) + 1, max } });
}

/* ═══════════════ 閒聊接上來的那一刻 ═══════════════ */

/**
 * 話聊到某件事上、角色剛把問句理好，此刻心跡這邊是什麼狀況。
 *
 * 零 AI、兩次查詢。回的是「已經在記了」還是「可以記」，前端據此決定要出
 * 「這件事你在記了」還是「先記下這件事」——**不由前端自己判**，
 * 額度與比對的規則若在前端再寫一份，兩邊遲早各說各話。
 *
 * 比對兩層，都是純字串：
 *   一、question_norm 對上（與一事不二占、xinji_suggest 認的是同一個鍵）
 *   二、事由與某條線的標題／標的互相包含（「那筆尾款」對上「尾款」）
 * 對不上就是新的一件事。寧可多開一條也不要歸錯——歸錯的那條線，
 * 溫度曲線與應期閉環從此都是別件事的。
 */
export async function threadHint(
  db: SupabaseClient, uid: string, plan: string,
  p: { question?: unknown; topic?: unknown },
): Promise<{
  thread: { id: string; title: string; casts: number } | null;
  open: number; max: number; can_add: boolean;
  fallback: { id: string; title: string } | null;
}> {
  const max = threadQuotaOf(plan);
  const { data } = await db.from("threads").select("id, title, subject, question_norm, last_cast_at, opened_at")
    .eq("user_id", uid).eq("status", "open")
    .order("last_cast_at", { ascending: false, nullsFirst: false }).limit(20);
  const rows = (data ?? []) as {
    id: string; title: string; subject: string | null; question_norm: string | null;
  }[];
  const open = rows.length;

  const norm = normalizeQuestion(String(p.question ?? ""));
  const topic = String(p.topic ?? "").trim();
  let hit = norm ? rows.find((r) => r.question_norm && r.question_norm === norm) ?? null : null;
  if (!hit && topic.length >= 2) {
    hit = rows.find((r) => {
      for (const name of [r.title, r.subject ?? ""]) {
        if (name.length < 2) continue;
        if (name.includes(topic) || topic.includes(name)) return true;
      }
      return false;
    }) ?? null;
  }

  let thread: { id: string; title: string; casts: number } | null = null;
  if (hit) {
    const { count } = await db.from("casts").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("thread_id", hit.id);
    thread = { id: hit.id, title: hit.title, casts: count ?? 0 };
  }

  return {
    thread,
    open, max, can_add: open < max,
    // 記不下新的一件時，指一條現成的線出來。免費只記一件，若不指路，
    // 這裡就只剩一句「額度滿了」——而他手上正有一件想記的事。
    fallback: !thread && open >= max && rows.length ? { id: rows[0].id, title: rows[0].title } : null,
  };
}

/** 把「理好的問句」縮成一個事由（心事的名字）。
 *
 *  模型擬題時會順手給一個（[[DRAFT|問句|用神|事由|一句話]] 的第三格），
 *  這一支是它沒給、或給了一坨的時候頂上的那個。純字串處理、零成本。
 *  切得粗是可以的——這個名字在前端是可以改的，而預設值只要「看得出是哪件事」。 */
export function topicOf(question: string): string {
  const TIME_WINDOW = [
    /^(這|下|未來|接下來)?[一二三四五六七八九十兩半\d]*\s*(個月|週|周|星期|年|天|日)(之?內|以?前|底前|底)?[，,]?/,
    /^(這個?月|下個?月|今年|明年|年底前?|月底前?|近期|最近)[，,]?/,
  ];
  let q = String(question ?? "").trim()
    .replace(/^(請問|想問|我想問|幫我看看?|幫我算算?)/, "")
    // 先剝「我」再剝時間窗：「我這個月的財運」兩者都在前面，順序反了就只剝得掉一個。
    // 只剝「我」——「這／那／此」不剝，它們幾乎都是名詞的一部分（那筆尾款、這間店、
    // 這段感情），剝掉之後剩下的「筆尾款」不是任何人會替一件事取的名字。
    .replace(/^我的?/, "")
    .replace(/[？?。！!，,、\s]+$/g, "");
  // 時間窗是問句的要素，不是這件事的名字：「三個月內那筆尾款…」記成一件事，
  // 它的名字是「那筆尾款」——三個月後這條線還在，名字裡卻寫著三個月內。
  for (const re of TIME_WINDOW) q = q.replace(re, "");
  // 切在第一個「求結果」的詞之前：留下的通常就是那件事本身
  const cut = q.search(/(會不會|能不能|該不該|可不可以|是否|能否|適不適合|追不追|進不進|值不值得|有沒有|如何|怎麼|嗎)/);
  if (cut > 1) q = q.slice(0, cut);
  q = q.replace(/^的/, "").replace(/[的之]$/, "").trim();
  return q.slice(0, 12);
}

/** 把一張散卦歸到既有的線上 */
export async function attachCast(
  db: SupabaseClient, uid: string, castId: unknown, threadId: unknown,
): Promise<XinjiResult> {
  const cid = String(castId ?? ""), tid = String(threadId ?? "");
  if (!cid || !tid) return err("缺卦或缺心事");
  const { data: t } = await db.from("threads").select("id, status")
    .eq("id", tid).eq("user_id", uid).maybeSingle();
  if (!t) return err("查無此心事");
  const { data: c } = await db.from("casts").select("id, category, created_at")
    .eq("id", cid).eq("user_id", uid).maybeSingle();
  if (!c) return err("查無此卦");
  if ((c as { category: string | null }).category === FORTUNE_CATEGORY)
    return err("日運不是問事，歸不進心事");

  await db.from("casts").update({ thread_id: tid }).eq("id", cid);
  await db.from("threads").update({ last_cast_at: (c as { created_at: string }).created_at }).eq("id", tid);
  return ok({ cast_id: cid, thread_id: tid });
}

/** 了結／重啟。了結不是刪除——那條線與它的卦都還在，只是不再佔在記的額度。 */
export async function setThreadStatus(
  db: SupabaseClient, uid: string, plan: string, threadId: unknown, close: boolean,
): Promise<XinjiResult> {
  const id = String(threadId ?? "");
  const { data: t } = await db.from("threads").select("id, status").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!t) return err("查無此心事");

  if (!close) {
    const { count } = await db.from("threads").select("id", { count: "exact", head: true })
      .eq("user_id", uid).eq("status", "open");
    if ((count ?? 0) >= threadQuotaOf(plan)) return err("在記的事已滿，重啟不了。先了結一件。");
  }
  await db.from("threads")
    .update({ status: close ? "closed" : "open", closed_at: close ? new Date().toISOString() : null })
    .eq("id", id);
  if (close) await brewNotes(db, uid);   // 結案那一句，當下就該在
  return ok({ thread_id: id, status: close ? "closed" : "open" });
}

/** 刪。卦不動（0045 的 on delete set null），留言隨線走。 */
export async function deleteThread(db: SupabaseClient, uid: string, threadId: unknown): Promise<XinjiResult> {
  const id = String(threadId ?? "");
  const { data: t } = await db.from("threads").select("id").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!t) return err("查無此心事");
  await db.from("threads").delete().eq("id", id).eq("user_id", uid);
  return ok({ thread_id: id, deleted: true });
}

/** 起卦前比對：這句問的是不是已經在記的某件事。
 *  pipeline 的一事不二占用同一支 normalizeQuestion，所以「被擋下來的那一句」
 *  與「該歸到哪條線」認的是同一個鍵。 */
export async function suggestThread(
  db: SupabaseClient, uid: string, question: unknown,
): Promise<XinjiResult> {
  const norm = normalizeQuestion(String(question ?? ""));
  if (!norm) return ok({ thread: null });
  const { data } = await db.from("threads").select(THREAD_COLS)
    .eq("user_id", uid).eq("status", "open").eq("question_norm", norm).limit(1);
  return ok({ thread: (data ?? [])[0] ?? null });
}

/* ═══════════════ 留言 ═══════════════ */

/** 點「回牠一句」：標記已回，回傳該去找誰、開場白帶什麼。
 *  這一支自己不計費——它只是把人送進閒聊，計費由 chat() 照既有規則走。
 *  付費點落在他真的想說話的那一刻，而不是他打開心跡的那一刻。 */
export async function replyToNote(db: SupabaseClient, uid: string, noteId: unknown): Promise<XinjiResult> {
  const id = String(noteId ?? "");
  const { data: n } = await db.from("thread_notes")
    .select("id, thread_id, character_id, kind, threads(title)")
    .eq("id", id).eq("user_id", uid).maybeSingle();
  if (!n) return err("查無此留言");
  const row = n as { id: string; thread_id: string | null; character_id: string; kind: string; threads: unknown };
  const th = (Array.isArray(row.threads) ? row.threads[0] : row.threads) as { title: string } | null;

  await db.from("thread_notes")
    .update({ replied_at: new Date().toISOString(), read_at: new Date().toISOString() })
    .eq("id", id);

  return ok({
    character_id: row.character_id,
    thread_id: row.thread_id,
    // 前端把它填進輸入框，人可以改。不直接代發——代發的話那句話就不是他說的了。
    prefill: th ? `關於「${th.title}」——` : "",
  });
}

export async function markNotesRead(db: SupabaseClient, uid: string, ids: unknown): Promise<XinjiResult> {
  const list = Array.isArray(ids) ? ids.map(String).slice(0, 50) : [];
  if (!list.length) return ok({ read: 0 });
  await db.from("thread_notes").update({ read_at: new Date().toISOString() })
    .eq("user_id", uid).in("id", list).is("read_at", null);
  return ok({ read: list.length });
}

/* ═══════════════ 月誌 ═══════════════ */

/** 台北月界的 'YYYY-MM'。 */
export const taipeiMonth = () => taipeiToday().slice(0, 7);

/** 該月的起訖（UTC 邊界，對齊台北月）。台北是 UTC+8，所以台北 m 月 1 日 00:00
 *  等於 UTC 前一日 16:00。差這八小時的話，月初月末那幾卦會歸錯月。 */
function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, -8, 0, 0)).toISOString();
  const to = new Date(Date.UTC(y, m, 1, -8, 0, 0)).toISOString();
  return { from, to };
}

export interface MonthlyStats {
  ym: string;
  casts: number;
  by_category: Record<string, number>;
  due_total: number;      // 這月的卦裡，有給應期的
  answered: number;       // 其中已回報的
  verdicts: { hit: number; partial: number; miss: number };
  busiest: { date: string; casts: number } | null;
  open_longest: { id: string; title: string; days: number; casts: number } | null;
  closed: number;
}

/**
 * 月誌的統計。全部現算，零 AI。
 *
 * 免費用戶也拿得到這一份——那本來就是他自己的資料，鎖它只會顯得小氣，
 * 而且鎖了他就不知道卷宗裡有東西。封的是「有人為你翻閱」那一層（卷首語）。
 */
export async function monthlyStats(db: SupabaseClient, uid: string, ym: string): Promise<MonthlyStats> {
  const { from, to } = monthRange(ym);

  const { data: cs } = await db.from("casts")
    .select("id, category, due_date, created_at, thread_id, feedback(verdict)")
    .eq("user_id", uid).gte("created_at", from).lt("created_at", to);
  // 日運不是問事，不進月誌——它每天都有一卦，算進去會把所有比例都洗掉
  const casts = ((cs ?? []) as {
    id: string; category: string | null; due_date: string | null; created_at: string;
    thread_id: string | null; feedback: unknown;
  }[]).filter((c) => c.category !== FORTUNE_CATEGORY);

  const by_category: Record<string, number> = {};
  const perDay: Record<string, number> = {};
  const verdicts = { hit: 0, partial: 0, miss: 0 };
  let due_total = 0, answered = 0;

  for (const c of casts) {
    const cat = c.category ?? "其他";
    by_category[cat] = (by_category[cat] ?? 0) + 1;
    // 以台北日分組
    const d = new Date(Date.parse(c.created_at) + 8 * 3600_000).toISOString().slice(0, 10);
    perDay[d] = (perDay[d] ?? 0) + 1;
    if (c.due_date) due_total++;
    const f = (Array.isArray(c.feedback) ? c.feedback[0] : c.feedback) as { verdict: number | null } | null;
    const v = f?.verdict ?? null;
    if (v === 1) { verdicts.hit++; answered++; }
    else if (v === 2) { verdicts.partial++; answered++; }
    else if (v === 3) { verdicts.miss++; answered++; }
  }

  const busiestEntry = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];

  // 未了：在記最久的那一件。月誌的「未了」段就講它一件——
  // 列成清單就變成待辦事項了，那不是回顧該有的口氣。
  const { data: ths } = await db.from("threads").select("id, title, opened_at")
    .eq("user_id", uid).eq("status", "open")
    .order("opened_at", { ascending: true }).limit(1);
  const oldest = (ths ?? [])[0] as { id: string; title: string; opened_at: string } | undefined;
  let open_longest: MonthlyStats["open_longest"] = null;
  if (oldest) {
    const { count } = await db.from("casts").select("id", { count: "exact", head: true })
      .eq("thread_id", oldest.id);
    open_longest = {
      id: oldest.id, title: oldest.title,
      days: daysBetween(oldest.opened_at.slice(0, 10), taipeiToday()),
      casts: count ?? 0,
    };
  }

  const { count: closed } = await db.from("threads").select("id", { count: "exact", head: true })
    .eq("user_id", uid).eq("status", "closed").gte("closed_at", from).lt("closed_at", to);

  return {
    ym, casts: casts.length, by_category, due_total, answered, verdicts,
    busiest: busiestEntry ? { date: busiestEntry[0], casts: busiestEntry[1] } : null,
    open_longest, closed: closed ?? 0,
  };
}

/** 餵給模型的那一段。刻意寫成人話而不是 JSON——模型讀人話寫出來的東西比較像人話。 */
export function statsDigest(s: MonthlyStats, threads: { title: string; casts: number }[]): string {
  const cats = Object.entries(s.by_category).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v} 卦`).join("、") || "無";
  const L = [
    `【月份】${s.ym}`,
    `【共問】${s.casts} 卦（${cats}）`,
    `【應期】給了應期的 ${s.due_total} 卦，他回報了 ${s.answered} 件：應驗 ${s.verdicts.hit}、部分 ${s.verdicts.partial}、未應 ${s.verdicts.miss}`,
  ];
  if (s.busiest && s.busiest.casts >= 2)
    L.push(`【最密的一天】${s.busiest.date}，一天 ${s.busiest.casts} 卦`);
  if (threads.length)
    L.push(`【這月動過的心事】${threads.map((t) => `「${t.title}」${t.casts} 卦`).join("、")}`);
  if (s.open_longest)
    L.push(`【還沒了結】「${s.open_longest.title}」已記 ${s.open_longest.days} 日、${s.open_longest.casts} 卦`);
  if (s.closed) L.push(`【這月了結】${s.closed} 件`);
  return L.join("\n");
}

/** 卷首語生成器。由呼叫端注入——xinji.ts 不 import services.ts（見檔頭 taipeiToday 的註解），
 *  而且注入之後，離線測試不必為了驗「免費看不到卷首語」而去接一個模型。 */
export type PrefaceGen = (digest: string) => Promise<{
  text: string; model: string;
  usage: { in: number; out: number; cacheWrite?: number; cacheRead?: number };
  estimated: boolean;
}>;

/**
 * 月誌。
 *
 *   免費 → 統計照給，卷首語回 null，locked 帶上「這月確實有東西」的憑據。
 *   付費 → 有存的就取存的；沒有就生一次、存起來。每人每月一次呼叫，走 haiku，
 *          0043 量到的量級是每人每月 0.1 元上下——這是它敢當訂閱主打的原因。
 *
 * 當月未終也給看。等月底才給，等於這個功能一個月只活一天。
 */
export async function monthlyReview(
  db: SupabaseClient, uid: string, plan: string, ymRaw: unknown, gen?: PrefaceGen,
): Promise<XinjiResult> {
  const ym = /^\d{4}-\d{2}$/.test(String(ymRaw ?? "")) ? String(ymRaw) : taipeiMonth();
  if (ym > taipeiMonth()) return err("那一月還沒到");

  const stats = await monthlyStats(db, uid, ym);
  const paid = plan !== "free";
  const current = ym === taipeiMonth();

  // 這月動過的心事（給卷首語當素材，也給前端畫「未了」）
  const { from, to } = monthRange(ym);
  const { data: tRows } = await db.from("threads")
    .select("id, title, status, opened_at, last_cast_at")
    .eq("user_id", uid).gte("last_cast_at", from).lt("last_cast_at", to).limit(10);
  const touched = ((tRows ?? []) as { id: string; title: string }[]);
  const counts = await Promise.all(touched.map(async (t) => {
    const { count } = await db.from("casts").select("id", { count: "exact", head: true })
      .eq("thread_id", t.id).gte("created_at", from).lt("created_at", to);
    return { title: t.title, casts: count ?? 0 };
  }));

  const base = { ym, current, stats, threads: counts };

  if (!paid) {
    // 未持牒：把「有東西」講清楚，但不劇透。這一段的說服力來自他自己的數字。
    return ok({
      ...base, preface: null, locked: true,
      locked_reason: stats.casts
        ? `${ym.slice(5)}月的卷宗已經齊了。只是觀中無人為你翻開。`
        : "這一月還沒有卦。等你問了，卷宗才有東西可錄。",
    });
  }

  const { data: had } = await db.from("monthly_reviews").select("preface, created_at")
    .eq("user_id", uid).eq("ym", ym).maybeSingle();
  if (had) return ok({ ...base, preface: (had as { preface: string }).preface, locked: false });

  // 沒卦就不生：花錢請模型對著一片空白寫感想，寫出來的一定是廢話
  if (!stats.casts) return ok({ ...base, preface: null, locked: false, empty: true });
  if (!gen) return ok({ ...base, preface: null, locked: false });

  try {
    const out = await gen(statsDigest(stats, counts));
    const preface = (out.text ?? "").trim();
    if (!preface) return ok({ ...base, preface: null, locked: false });
    // onConflict 忽略重複：兩個裝置同時開月誌，只留先寫進去的那一份，
    // 不覆蓋——覆蓋的話後開的人會看到跟先前不同的一段話。
    await db.from("monthly_reviews").upsert({
      user_id: uid, ym, preface, model: out.model,
      tokens_in: out.usage.in, tokens_out: out.usage.out,
    }, { onConflict: "user_id,ym", ignoreDuplicates: true });
    const { data: fresh } = await db.from("monthly_reviews").select("preface")
      .eq("user_id", uid).eq("ym", ym).maybeSingle();
    return ok({ ...base, preface: (fresh as { preface: string } | null)?.preface ?? preface, locked: false });
  } catch (e) {
    console.error("monthlyReview gen failed", e instanceof Error ? e.stack ?? e.message : String(e));
    // 生不出來就照給統計。少一段卷首語是遺憾，整頁打不開是故障。
    return ok({ ...base, preface: null, locked: false, gen_failed: true });
  }
}

/** 往月目錄：畫「往月　未啟封」那一列用。只回月份與卦數，不回內容。 */
export async function monthlyIndex(db: SupabaseClient, uid: string, plan: string): Promise<XinjiResult> {
  const { data: cs } = await db.from("casts").select("created_at, category")
    .eq("user_id", uid).order("created_at", { ascending: false }).limit(2000);
  const per: Record<string, number> = {};
  for (const c of (cs ?? []) as { created_at: string; category: string | null }[]) {
    if (c.category === FORTUNE_CATEGORY) continue;
    const ym = new Date(Date.parse(c.created_at) + 8 * 3600_000).toISOString().slice(0, 7);
    per[ym] = (per[ym] ?? 0) + 1;
  }
  const { data: opened } = await db.from("monthly_reviews").select("ym").eq("user_id", uid);
  const have = new Set((opened ?? []).map((r) => (r as { ym: string }).ym));
  const months = Object.entries(per).sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([ym, casts]) => ({ ym, casts, opened: have.has(ym) }));
  return ok({ months, paid: plan !== "free" });
}
