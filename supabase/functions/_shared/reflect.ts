// _shared/reflect.ts — 回評之後的反芻：這一卦錯在哪、靠的是哪幾條判法、那幾條撐住了沒有。
//
// 六六 2026-10-02 定的方向：規則本文不動，變的是「輕重」。
// 某條判法在印證裡老是不準，不代表它錯——是以後角色不在第一時間拿它當主論據。
// 所以這裡產出三樣東西，生效方式各不同：
//
//   ① cast_reflections ＋ reflection_rules：單卦反省紀錄。只存檔，不改任何行為。
//   ② user_reading_notes：關於「這個人」的提醒（他問感情時真正掛心的是什麼之類）。
//      自動生效：下一次解他的卦、答他的追問時帶進去。只影響理解問事，不影響卦理。
//   ③ rule_priority：每條判法的命中統計 → 優先／常規／降級。自動生效，但要有統計把握才動
//      （見 tierOf），且 locked 的列由人手定、重算不覆蓋。
//
// 反省本身在回評送出那一刻背景跑（waitUntil），不等人來撈。
//
// 這支刻意不 import services.ts：模型呼叫由呼叫端注入（ask），
// 好讓解析與分級邏輯能在 node 下測（dev/reflect-test.mts）。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/* ---------- 判法目錄 ----------
   反省時模型只能從這張表點名，統計才聚得起來（自由文字永遠合併不了）。
   粒度定在「會被拿來當結論依據的一條判法」，不是整段規則：
   「旺衰」降級沒有意義（不可能不看旺衰），「旬空主延遲」降級才有意義。
   ⚠ key 一旦上線就不要改名——改了等於把那條判法的歷史統計歸零。要拆要併就新增 key。 */
export const RULE_CATALOG: { key: string; label: string }[] = [
  { key: "subject",        label: "主體判定（自占／代占／交涉／兩造）" },
  { key: "yong_pick",      label: "依角色表取用神" },
  { key: "yong_polarity",  label: "用神極性（旺不一定吉）" },
  { key: "month_strength", label: "月令定旺衰" },
  { key: "day_effect",     label: "日辰生剋沖合用神" },
  { key: "moving_effect",  label: "動爻生剋用神／世爻" },
  { key: "huitou",         label: "化回頭生剋" },
  { key: "jin_tui",        label: "化進神／退神" },
  { key: "chong_he",       label: "沖合大於生剋" },
  { key: "sanhe",          label: "三合局" },
  { key: "xunkong",        label: "旬空主虛、主延遲" },
  { key: "yuepo",          label: "月破主無力" },
  { key: "rumu",           label: "入墓主困、主阻" },
  { key: "andong",         label: "暗動／日沖靜爻" },
  { key: "fushen",         label: "伏神出伏與否" },
  { key: "jing_gua",       label: "全靜卦取日辰論" },
  { key: "liuchong_he",    label: "六沖卦散／六合卦成" },
  { key: "fanyin_fuyin",   label: "反吟伏吟" },
  { key: "shi_ying",       label: "世應生剋（交涉主軸）" },
  { key: "sishen",         label: "原神忌神動靜" },
  { key: "liushou",        label: "六獸取象" },
  { key: "due_method",     label: "應期取法（值沖合、出空填實）" },
];
const RULE_KEYS = new Set(RULE_CATALOG.map((r) => r.key));
const RULE_LABEL = Object.fromEntries(RULE_CATALOG.map((r) => [r.key, r.label]));

/* ---------- 歸因分類 ----------
   misread 與 report 刻意列成獨立類：前者是模型把盤面讀錯（規則沒機會被驗到），
   後者是卦沒錯、是回報與卦說的其實相符或資訊不足以判。這兩類不能算到判法頭上，
   否則判法會替幻覺與回報偏差背鍋。 */
export const ATTRIBUTIONS: Record<string, string> = {
  hit:      "命中（論斷與結果相符）",
  question: "問事理解偏了（他真正問的不是字面那件事）",
  yong:     "主體或用神取錯",
  strength: "旺衰或動變判錯",
  timing:   "應期推錯（事情對、時間不對）",
  misread:  "盤面事實讀錯（爻位、動靜、伏神講錯）",
  report:   "卦沒錯，是回報與論斷其實相符，或資訊不足以判",
  unclear:  "看不出來",
};

export const VERDICT_TXT: Record<number, string> = { 1: "準", 2: "部分準", 3: "不準" };

/* ---------- 反省提示 ----------
   接在 RULES 後面（services.ts 的 reflect mode）：系統提示前綴與解卦同一份，
   吃得到同一份快取，反省多讀九千字規則只付一成的錢。 */
export const REFLECT_RULES = `【以上是解卦規則本文。現在你不是在解卦——你是校勘者，在回看一張已經有結果的卦。】
上方的輸出格式、聲線、術語禁令一律不適用於此處；只照本段的格式輸出。

你會拿到：盤面、問事、當時給問卦人的論斷（含追問往來與追問中做過的修正）、以及問卦人事後的回報（準／部分準／不準，可能附一句心得）。

照這個順序做，順序不能反：
①【先只看論斷，不看結果】從論斷正文與追問往來找出它實際「靠哪幾條判法」得出結論。主論據（primary）＝拿掉它結論就不成立；輔論據（secondary）＝有提到、有加分但非決定性。沒用到的判法一律不列。判法只能從下方目錄點名。
②【再對結果】逐條判：held＝這條判法在此卦撐住了；failed＝規則照本文正確套用了，但結果不照它走；misapplied＝判法本身沒被正確套用（盤面讀錯、方向算反、該用不用）；unclear＝回報資訊不足以判這一條。
③【歸因】整卦最主要的落差來源，從歸因表擇一。結果相符就填 hit。
④【反事實】若不準或部分準：同一盤面上，哪一個判斷點換一種判法就會對上結果？一兩句，說不出來就填 null。不可為了湊出答案而改讀盤面。
⑤【關於這個人】回報或追問若透露了「這位問卦人」日後解卦值得記住的事（他問這類事時真正掛心的是什麼、他的處境、他用詞的習慣），寫一句；只寫對理解他問事有用的，不寫卦理、不寫評價、不寫敏感個資細節。沒有就填 null。

【不可迎合結果】不準不代表每條判法都錯；準也不代表每條都對。回報可能有偏差，「部分準」尤其要分清哪一半準。寧可填 unclear，不可硬判。

【判法目錄】（只能用這些 key）
${RULE_CATALOG.map((r) => `${r.key}＝${r.label}`).join("\n")}

【歸因表】
${Object.entries(ATTRIBUTIONS).map(([k, v]) => `${k}＝${v}`).join("\n")}

【輸出格式·只輸出這五個標籤，標籤外不要寫任何字】
<rules>key:primary|secondary:held|failed|misapplied|unclear，多條以 ; 分隔；一條都沒有就填 none</rules>
<attr>歸因 key</attr>
<why>兩三句：這卦的論斷靠什麼、結果怎麼走、落差在哪</why>
<cf>反事實一兩句，或 null</cf>
<lesson>關於這個人的一句話，或 null</lesson>`;

/* ---------- 解析 ---------- */
export type RuleRow = { key: string; role: "primary" | "secondary"; outcome: "held" | "failed" | "misapplied" | "unclear" };
export type Reflection = { rules: RuleRow[]; attr: string; why: string; cf: string | null; lesson: string | null };

const tagOf = (text: string, tag: string) => {
  const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  return m ? m[1].trim() : null;
};
const nullish = (s: string | null) => !s || /^(null|none|無|没有|沒有)$/i.test(s) ? null : s;

/** 解析反省輸出。目錄外的 key、拼錯的 role/outcome 一律丟掉——寧可少一條，
 *  不可讓一個打錯的字在統計表裡長出一條沒人認得的判法。
 *  <attr> 認不得就落 unclear；整段沒有 <rules> 也照樣回（只是沒有判法列）。 */
export function parseReflection(text: string): Reflection {
  const rulesRaw = tagOf(text, "rules") ?? "";
  const seen = new Set<string>();
  const rules: RuleRow[] = [];
  for (const part of rulesRaw.split(/[;；\n]/)) {
    const [k, role, outcome] = part.split(/[:：]/).map((s) => s.trim().toLowerCase());
    if (!k || !RULE_KEYS.has(k) || seen.has(k)) continue;
    if (role !== "primary" && role !== "secondary") continue;
    if (!["held", "failed", "misapplied", "unclear"].includes(outcome)) continue;
    seen.add(k);
    rules.push({ key: k, role, outcome: outcome as RuleRow["outcome"] });
  }
  const attrRaw = (tagOf(text, "attr") ?? "").toLowerCase();
  return {
    rules,
    attr: attrRaw in ATTRIBUTIONS ? attrRaw : "unclear",
    why: (tagOf(text, "why") ?? "").slice(0, 400),
    cf: nullish(tagOf(text, "cf"))?.slice(0, 300) ?? null,
    lesson: nullish(tagOf(text, "lesson"))?.slice(0, 120) ?? null,
  };
}

/* ---------- 分級 ----------
   要有統計把握才動，所以用 Wilson 區間而不是裸命中率：
   3 中 0 的命中率是 0%，但區間寬到什麼都說明不了，這時不該降級。
   降級＝這條判法命中率的「上界」都還低於全站基準；優先＝「下界」都高於基準。
   樣本少時區間自然寬，兩個條件都不成立，就停在常規——不必另設人工門檻去猜。
   主論據權重 1、輔論據 0.5：輔論據本來就不承擔結論，不該跟主論據等量計。 */
export const MIN_RULE_N = 8;          // 單條判法加權樣本低於此數，一律常規
export const MIN_BASELINE_N = 30;     // 全站加權樣本低於此數，整套分級都不啟動
const Z = 1.28;                        // 約 80% 雙尾——寬一點，寧可慢動也不要亂動

export type RuleStat = { key: string; held: number; failed: number };   // 已加權

export function wilson(held: number, n: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = held / n, z2 = Z * Z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = (Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

/** 1 優先 · 0 常規 · -1 降級 */
export function tierOf(s: RuleStat, baseline: number): -1 | 0 | 1 {
  const n = s.held + s.failed;
  if (n < MIN_RULE_N) return 0;
  const { lo, hi } = wilson(s.held, n);
  if (hi < baseline) return -1;
  if (lo > baseline) return 1;
  return 0;
}

/** 整張表一起算。回傳 null 代表全站樣本還不夠，整套分級不啟動（全部常規）。 */
export function computeTiers(stats: RuleStat[]): { baseline: number; tiers: Record<string, -1 | 0 | 1> } | null {
  const held = stats.reduce((a, s) => a + s.held, 0);
  const n = stats.reduce((a, s) => a + s.held + s.failed, 0);
  if (n < MIN_BASELINE_N) return null;
  const baseline = held / n;
  const tiers: Record<string, -1 | 0 | 1> = {};
  for (const s of stats) tiers[s.key] = tierOf(s, baseline);
  return { baseline, tiers };
}

/* ---------- 給解卦人看的兩段 ---------- */
export type PriorityRow = { rule_key: string; tier: number; held: number; failed: number };

/** 判法優先度提示。只寫偏離常規的那幾條；沒有就回空字串（不佔 token）。 */
export function priorityBlock(rows: PriorityRow[]): string {
  const fmt = (r: PriorityRow) =>
    `・${RULE_LABEL[r.rule_key] ?? r.rule_key}（印證 ${Math.round(r.held + r.failed)} 次，撐住 ${Math.round(r.held)} 次）`;
  const down = rows.filter((r) => r.tier < 0 && RULE_LABEL[r.rule_key]).map(fmt);
  const up = rows.filter((r) => r.tier > 0 && RULE_LABEL[r.rule_key]).map(fmt);
  if (!down.length && !up.length) return "";
  return [
    "【判法輕重·依本觀過往印證統計·只調輕重、不改規則】",
    "規則本文照舊全部適用、推演照舊全部要做。這裡只決定：多條依據並存時，哪一條放前面講、結論靠哪一條撐。",
    ...(down.length ? [
      "以下判法在已印證的卦裡撐住的比例偏低——仍要推、可以提，但不在開頭的結論裡第一個拿它當理由；若整個結論只靠它撐，語氣放輕、把握度標低，並優先找別的依據：",
      ...down,
    ] : []),
    ...(up.length ? [
      "以下判法在已印證的卦裡撐住的比例偏高——依據並存時優先採用、優先講：",
      ...up,
    ] : []),
  ].join("\n");
}

/** 這位問卦人過往印證留下的提醒。 */
export function userNotesBlock(notes: string[]): string {
  if (!notes.length) return "";
  return `【這位問卦人過往印證留下的提醒】\n${notes.map((n) => `・${n}`).join("\n")}\n` +
    "只用來更準確理解他在問什麼、處境如何；不得因此改變本卦的卦理判斷，正文也不要提「過往印證」「紀錄顯示」這類字眼。";
}

/* ---------- 資料庫 ---------- */
export const USER_NOTES_MAX = 5;

/** 判法輕重提示的模組快取：它一天變不了幾次，不必每次解卦都查。
 *  10 分鐘過期——重算後最遲 10 分鐘生效，可以接受。 */
let prioCache: { at: number; text: string } | null = null;
const PRIO_TTL_MS = 10 * 60_000;

export async function loadPriorityBlock(db: SupabaseClient): Promise<string> {
  if (prioCache && Date.now() - prioCache.at < PRIO_TTL_MS) return prioCache.text;
  try {
    const { data, error } = await db.from("rule_priority").select("rule_key, tier, held, failed").neq("tier", 0);
    if (error) throw error;
    const text = priorityBlock((data ?? []) as PriorityRow[]);
    prioCache = { at: Date.now(), text };
    return text;
  } catch (e) {
    // 表還沒建（migration 未跑）或讀不到：不擋解卦，那是加分項
    console.error("loadPriorityBlock failed", e instanceof Error ? e.message : e);
    return "";
  }
}
export function __resetPriorityCache() { prioCache = null; }

export async function loadUserNotes(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await db.from("user_reading_notes").select("note, created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(USER_NOTES_MAX);
    if (error) throw error;
    return userNotesBlock(((data ?? []) as { note: string }[]).map((r) => r.note));
  } catch (e) {
    console.error("loadUserNotes failed", e instanceof Error ? e.message : e);
    return "";
  }
}

/** 重算判法分級。聚合在 SQL（rule_stats()，免得被 db-max-rows 切掉），分級在這裡（可測）。
 *  locked 的列不動：那是人手定下的，統計不該蓋過它。 */
export async function recomputePriority(db: SupabaseClient): Promise<void> {
  const { data, error } = await db.rpc("rule_stats");
  if (error) { console.error("rule_stats failed", error.message); return; }
  const stats = ((data ?? []) as { rule_key: string; held: number; failed: number }[])
    .map((r) => ({ key: r.rule_key, held: Number(r.held), failed: Number(r.failed) }));
  const res = computeTiers(stats);
  const { data: locked } = await db.from("rule_priority").select("rule_key").eq("locked", true);
  const lockedSet = new Set(((locked ?? []) as { rule_key: string }[]).map((r) => r.rule_key));
  const now = new Date().toISOString();
  const rows = stats.filter((s) => !lockedSet.has(s.key)).map((s) => ({
    rule_key: s.key, held: s.held, failed: s.failed,
    tier: res ? res.tiers[s.key] : 0,
    baseline: res ? res.baseline : null,
    updated_at: now,
  }));
  if (rows.length) {
    const { error: upErr } = await db.from("rule_priority").upsert(rows, { onConflict: "rule_key" });
    if (upErr) console.error("rule_priority upsert failed", upErr.message);
  }
  prioCache = null;
}

/** 模型呼叫由呼叫端注入：回 text 與要記帳的用量資訊 */
export type Ask = (input: string) => Promise<{ text: string; log?: () => Promise<void> }>;

/** 反省一卦。回評送出（或改寫）後背景呼叫；任何一步失敗都只記錯不丟出——
 *  回評本身已經成立，反省是事後的功課。 */
export async function reflectCast(db: SupabaseClient, castId: string, deps: {
  ask: Ask; chartText: (chart: unknown, question: string) => string;
}): Promise<Reflection | null> {
  try {
    const { data: c } = await db.from("casts")
      .select("id, user_id, question, chart, reading, deep_reading, due_date, created_at, yong_qin, yong_via_shi, yong_via_ying, category")
      .eq("id", castId).maybeSingle();
    if (!c) return null;
    const { data: fb } = await db.from("feedback").select("verdict, note, answered_at").eq("cast_id", castId).maybeSingle();
    const verdict = Number((fb as { verdict: number | null } | null)?.verdict ?? 0);
    if (![1, 2, 3].includes(verdict)) return null;   // 0＝未發生，沒有結果可對
    const { data: fus } = await db.from("followups").select("question, answer, ask, revision, created_at")
      .eq("cast_id", castId).order("created_at", { ascending: true });

    const input = reflectInput(c as CastForReflect, fb as FbForReflect, (fus ?? []) as FuForReflect[])
      .replace("{{CHART}}", () => deps.chartText((c as CastForReflect).chart, (c as CastForReflect).question ?? ""));
    const r = await deps.ask(input);
    await r.log?.();
    const ref = parseReflection(r.text);
    const cast = c as CastForReflect;

    await db.from("cast_reflections").upsert({
      cast_id: castId, user_id: cast.user_id, verdict, attribution: ref.attr,
      analysis: ref.why, counterfactual: ref.cf, lesson: ref.lesson, created_at: new Date().toISOString(),
    }, { onConflict: "cast_id" });
    // 判法列整批換掉：改評時（準→不準）舊判定不能留著跟新判定一起算
    await db.from("reflection_rules").delete().eq("cast_id", castId);
    if (ref.rules.length) {
      await db.from("reflection_rules").insert(ref.rules.map((x) => ({
        cast_id: castId, rule_key: x.key, role: x.role, outcome: x.outcome, verdict,
      })));
    }
    // 關於這個人的提醒：一卦最多一句，改評就換掉那一句
    await db.from("user_reading_notes").delete().eq("cast_id", castId);
    if (ref.lesson) {
      await db.from("user_reading_notes").insert({ user_id: cast.user_id, cast_id: castId, note: ref.lesson });
    }
    await recomputePriority(db);
    return ref;
  } catch (e) {
    console.error("reflectCast failed", castId, e instanceof Error ? e.message : e);
    return null;
  }
}

type CastForReflect = {
  id: string; user_id: string; question: string | null; chart: unknown; reading: string | null;
  deep_reading: string | null; due_date: string | null; created_at: string;
};
type FbForReflect = { verdict: number; note: string | null; answered_at: string | null } | null;
type FuForReflect = { question: string; answer: string; ask: string | null; revision: string | null };

/** 組反省的輸入。盤面文字由呼叫端注入的 chartText 補（dongyao.chartTextFull 在 node 測不到），
 *  所以這裡先留一個 {{CHART}}。 */
export function reflectInput(c: CastForReflect, fb: FbForReflect, fus: FuForReflect[]): string {
  const fu = fus.map((f, i) =>
    `（追問${i + 1}）問：${f.question}\n答：${f.answer}` +
    (f.ask ? `\n（解卦人反問）${f.ask}` : "") +
    (f.revision ? `\n（解卦人據此修正）${f.revision}` : "")).join("\n\n");
  return [
    "【盤面】\n{{CHART}}",
    `【占期】${String(c.created_at).slice(0, 10)}${c.due_date ? `　【當時給的應期】${c.due_date}` : ""}`,
    `【問事】${c.question ?? ""}`,
    `【當時的論斷】\n${c.reading ?? ""}`,
    ...(c.deep_reading ? [`【完整卦理】\n${String(c.deep_reading).slice(0, 3000)}`] : []),
    ...(fu ? [`【追問往來】\n${fu}`] : []),
    `【問卦人回報】${VERDICT_TXT[fb?.verdict ?? 0] ?? "?"}${fb?.answered_at ? `（${String(fb.answered_at).slice(0, 10)}）` : ""}` +
      (fb?.note ? `\n他寫：「${fb.note}」` : "\n（沒有留心得）"),
  ].join("\n\n");
}

/** 背景執行：Edge 上掛 waitUntil，不拖慢回應；本機（測試）就直接跑。 */
export function inBackground(task: Promise<unknown>) {
  // @ts-ignore EdgeRuntime 為 Supabase 提供的全域
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(task);
  else task.catch((e) => console.error("bg task err", e));
}
