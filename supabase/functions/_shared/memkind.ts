// memkind.ts — 記憶分類與時效（六六 2026-09-30）
//
// 病灶：一則記憶裡混著「他這個人」「那天發生的事」「那陣子的情緒」，甚至角色自己的推論
// （「師妹判斷他真正的憤怒源自虧損」）。模型讀到的是一整段現在式，過了一個月還當他在氣頭上。
// 9/29 在提示詞裡加了「記憶是往事」與日子戳，沒有用：日子戳的是**彙整那天**，不是事情發生那天；
// 而「他對男性普遍抱持負面看法」長得像偏好，正好落在「偏好是一直都在的」那條豁免裡。
//
// 改法：時效不交給模型自律，交給程式。
//   ・寫入時分三類，一則只放一種：其人（trait）／事件（event）／狀態（state）
//   ・日子是**發生那天**：彙整時對話逐日標〔M/D〕，模型照標的填
//   ・狀態超過 STATE_FRESH_DAYS 就不注入（釘選的除外）——模型看不到，就不可能拿它回話
//   ・舊資料沒有類別：讀的時候用字判一下（情緒、壓力、生病……當狀態）

export type MemKind = "trait" | "event" | "state";
// 主詞是角色自己的那則是角色的話，不是他的事（915d459，2026-11-24 併入）
// 只認「角色＋說話／判斷的動詞」：「師兄昨天來找他借書」可能是他生活裡的真人，不能整則丟掉（審查 2026-11-24）
const SELF_SUBJECT = /^(?:(?:師妹|大師兄|師兄|觀喵|觀貓|喵師傅)(?:說|指|認為|判斷|覺得|提醒|勸|問|答|叮囑|告訴|猜|推測|看出)|你)/;
export const STATE_FRESH_DAYS = 7;

const LABEL: Record<string, MemKind> = { 其人: "trait", 事件: "event", 狀態: "state" };

// 舊資料的狀態判定：寧可多判（只是七天後不注入，記憶頁仍看得到、可釘選），不可漏判。
const STATE_RE = /(情緒|心情|壓力|焦慮|難過|低落|煩|累|生病|感冒|發燒|受傷|失眠|忙|加班|趕|崩潰|哭|生氣|憤怒|不爽|平復)/;

export type MemRow = {
  body: string; kind?: string | null; happened_on?: string | null;
  created_at?: string; pinned_at?: string | null;
};

export function kindOf(m: MemRow): MemKind {
  if (m.kind === "trait" || m.kind === "event" || m.kind === "state") return m.kind;
  return STATE_RE.test(m.body) ? "state" : "event";
}

/** 事情發生的那天；沒標就退回記下的那天。 */
export const dayOf = (m: MemRow): string | undefined => m.happened_on || m.created_at;

/** 過時的狀態：不注入（記憶頁照樣列出，標成淡去）。釘選的永遠不淡。 */
export function isDormant(m: MemRow, now = Date.now()): boolean {
  if (m.pinned_at || kindOf(m) !== "state") return false;
  const t = Date.parse(dayOf(m) ?? "");
  return Number.isFinite(t) && now - t > STATE_FRESH_DAYS * 86400_000;
}

/** 注入用：分三段。age 是日子戳（chat.ts 的 memAge），由外面給以免循環引用。 */
export function arrangeMemories(rows: MemRow[], age: (iso?: string) => string, now = Date.now(), keepDormant = false): string {
  // keepDormant：被他這句話喚醒的舊狀態照樣給（他自己提起了，角色不能裝不知道）
  const live = keepDormant ? rows : rows.filter((m) => !isDormant(m, now));
  const by = (k: MemKind) => live.filter((m) => kindOf(m) === k)
    .sort((a, b) => Date.parse(dayOf(b) ?? "") - Date.parse(dayOf(a) ?? ""));
  const out: string[] = [];
  const traits = by("trait");
  if (traits.length) out.push("【他這個人】\n" + traits.map((m) => `・${m.body}`).join("\n"));
  const events = by("event");
  if (events.length) out.push("【發生過的事】（〔〕是那天）\n" + events.map((m) => `・${age(dayOf(m))}${m.body}`).join("\n"));
  const states = by("state");
  if (states.length) {
    out.push("【他那時的狀態】只代表那天。之後他沒再提的，你不知道現在怎樣——想知道就問一句，別當他還在那樣\n"
      + states.map((m) => `・${age(dayOf(m))}${m.body}`).join("\n"));
  }
  return out.join("\n");
}

/** 彙整用：對話逐日標〔M/D〕，模型才填得出「那天」。 */
export function datedDialog(msgs: { role: string; body: string; created_at?: string }[], line: (m: { role: string; body: string }) => string): string {
  let last = "";
  const out: string[] = [];
  for (const m of msgs) {
    const d = md(m.created_at);
    if (d && d !== last) { out.push(`〔${d}〕`); last = d; }
    out.push(line(m));
  }
  return out.join("\n");
}
const tw = (iso?: string) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? new Date(t + 8 * 3600_000) : null; };
function md(iso?: string): string {
  const d = tw(iso);
  return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : "";
}

/** 解析彙整輸出：每行「類別｜M/D｜內容」。認不出格式的行一律丟掉（六六 2026-11-27：曾把一個「ｋ」、半句「有新記憶」存成回憶）。
 *  M/D 補年份：取不晚於這批對話最後一天的那一年（跨年的 12/31 不會被當成明年）。 */
const MIN_BODY = 4;   // 「他養了貓」四個字也是一件事；「ｋ」「有新記憶」不是（後者沒有類別欄，本來就收不進來）
export function parseMemoryLines(text: string, batchLastIso?: string): { body: string; kind: MemKind | null; happened_on: string | null }[] {
  const last = tw(batchLastIso) ?? new Date(Date.now() + 8 * 3600_000);
  const fallbackDay = last.toISOString().slice(0, 10);
  const out: { body: string; kind: MemKind | null; happened_on: string | null }[] = [];
  for (const raw of (text ?? "").split("\n")) {
    // 模型偶爾加編號、粗體：先剝掉，格式小錯不該讓一則真事掉了
    const line = raw.replace(/\*\*/g, "").replace(/^[・\-*•\s]+/, "").replace(/^\d+\s*[.、．)]\s*/, "").trim();
    if (!line || /^無新記憶[。.]?$/.test(line)) continue;
    // 分隔符也認冒號（「事件：11/21：……」）；日子欄取最短，內容裡的冒號不受影響
    const m = line.match(/^(其人|事件|狀態)\s*[|｜:：]\s*([^|｜:：]*?)\s*[|｜:：]\s*(.+)$/);
    if (!m) continue;
    if (m[3].trim().length < MIN_BODY) continue;   // 太短的不是一件事
    const kind = LABEL[m[1]];
    let day: string | null = null;
    const dm = m[2].match(/^(\d{1,2})\s*[/／月]\s*(\d{1,2})/);
    if (dm) {
      const mo = Number(dm[1]), d = Number(dm[2]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        let y = last.getUTCFullYear();
        if (mo > last.getUTCMonth() + 1 || (mo === last.getUTCMonth() + 1 && d > last.getUTCDate())) y--;
        day = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    // 其人不綁日子；事件、狀態沒填就當這批對話最後那天
    out.push({ body: m[3].trim().slice(0, 200), kind, happened_on: kind === "trait" ? null : day ?? fallbackDay });
  }
  // 主詞是角色自己的（「師妹指他……」「師兄說……」）是角色的話，不是他的事——不收
  return out.filter((it) => !SELF_SUBJECT.test(it.body)).slice(0, 2);
}

/* ── 什麼時候形成回憶（六六 2026-10-05：統整太頻繁，每則回憶都很短）──
   舊做法：明細超過 40 則就把最舊的 20 則濃縮成一則——大約每聊十來句就生一則，
   一段話被切成好幾截，每截都只剩一兩句。
   新做法：以「一場對話」為單位。隔 SESSION_GAP_MS 沒說話就算一場結束；
   結束了的場次累積到 MIN_BATCH 則才一起濃縮，像人隔一陣子回頭想那幾次聊了什麼。
   ・最近 KEEP_TAIL 則永遠不動（最高方案注入 16 輪＝32 則，濃縮掉就斷了上下文）
   ・場次很小、但已經放了一週：照樣收，不讓零星幾句永遠掛著
   ・一場聊得太長（還沒結束就超過 HARD_CAP）：先收最舊的一段，免得明細無限長 */
export const SESSION_GAP_MS = 3 * 3600_000;
const KEEP_TAIL = 32;
const MIN_BATCH = 24;
const STALE_MS = 7 * 86400_000;
const STALE_MIN = 8;
const HARD_CAP = 80;
const MAX_BATCH = 120;
export const EXPIRE_MS = 24 * 3600_000;   // 明細存活上限：過了就收成回憶並刪掉（chat.ts 的回灌與 chat_history 同一條線）

/** 由舊到新的明細 → 這次要濃縮最舊的幾則（0＝先不收）。 */
export function condenseCount(msgs: { created_at?: string }[], now = Date.now()): number {
  // 超過一天的明細一律先收成回憶、再刪（六六 2026-11-03：隔天的閒聊不再回灌，也不留逐字稿）。
  // 這條優先於 KEEP_TAIL／MIN_BATCH：反正已經不注入了，留著只是等著被誤接。
  let expired = 0;
  while (expired < msgs.length && now - Date.parse(msgs[expired]?.created_at ?? "") >= EXPIRE_MS) expired++;
  // 一場跨過一天那條線時不切半場：退回到場次邊界，那一場等整場都過期再一起收（避免碎片回憶）
  if (expired < msgs.length) {
    const at = (i: number) => Date.parse(msgs[i]?.created_at ?? "");
    while (expired > 0 && !(at(expired) - at(expired - 1) >= SESSION_GAP_MS)) expired--;
  }
  if (expired > 0) return Math.min(expired, MAX_BATCH);
  const eligible = msgs.length - KEEP_TAIL;
  if (eligible <= 0) return 0;
  const at = (i: number) => Date.parse(msgs[i]?.created_at ?? "");
  // 這一場從哪裡開始：從最後一則往前，碰到隔了 SESSION_GAP_MS 的地方就是邊界
  let start = msgs.length - 1;
  while (start > 0 && !(at(start) - at(start - 1) >= SESSION_GAP_MS)) start--;
  if (now - at(msgs.length - 1) >= SESSION_GAP_MS) start = msgs.length;   // 最後那場也已經結束
  const finished = Math.min(start, eligible);
  if (finished >= MIN_BATCH) return Math.min(finished, MAX_BATCH);
  if (finished >= STALE_MIN && now - at(0) >= STALE_MS) return Math.min(finished, MAX_BATCH);
  if (eligible >= HARD_CAP) return Math.min(eligible, MAX_BATCH);
  return 0;
}

/* ── 一直繞回同一件事（六六 2026-10-12：師妹卡在那碗湯；915d459，2026-11-24 併入）──
   超過一天的明細已不回灌（EXPIRE_MS），這裡管的是同一天、同一場裡的打轉：
   取角色最近 4 則裡至少 3 則都出現的三字詞（只收中文、不含虛字），他最近說的話裡沒有的才算。 */
const FUNC = /[你我他她牠的了是不在有就也都這那個麼嗎呢吧啊和與而又很太更再還]/;
export function repeatedTopics(turns: { role: string; body: string }[], message = ""): string[] {
  const mine = turns.filter((t) => t.role === "assistant").slice(-4).map((t) => t.body);
  if (mine.length < 3) return [];
  const his = turns.filter((t) => t.role === "user").slice(-3).map((t) => t.body).join("") + message;
  const count = new Map<string, number>();
  for (const b of mine) {
    const seen = new Set<string>();
    for (let i = 0; i + 3 <= b.length; i++) {
      const g = b.slice(i, i + 3);
      if (!/^[一-鿿]{3}$/.test(g) || FUNC.test(g) || seen.has(g)) continue;
      seen.add(g);
      count.set(g, (count.get(g) ?? 0) + 1);
    }
  }
  const hits = [...count].filter(([g, n]) => n >= 3 && !his.includes(g)).map(([g]) => g);
  // 相鄰的三字詞（「薑棗水」「棗水喝」）只留第一個
  const out: string[] = [];
  for (const g of hits) if (!out.some((o) => o.includes(g.slice(0, 2)) || o.includes(g.slice(1)))) out.push(g);
  return out.slice(0, 2);
}

/* ── 同一件事不另開一格（六六 2026-10-12：武曲星坐命兩天內佔了兩格）──
   新寫的一則跟最近的某一則講的是同一件事（字面重疊夠多、類別相同），就把那一則改寫成新的，不另插一列。
   改寫會蓋掉舊的那則，誤併救不回來，所以門檻比 915d459 原本的 0.35 高（2026-11-24）。 */
const bigrams = (t: string) => { const s = new Set<string>(); const c = t.replace(/[^一-鿿A-Za-z0-9]/g, ""); for (let i = 0; i + 2 <= c.length; i++) s.add(c.slice(i, i + 2)); return s; };
export function overlap(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return n / Math.min(A.size, B.size);
}
export const SAME_THING = 0.65;   // 0.5 時「感冒頭痛」與「加班頭痛」會被當同一件（0.56）
// 太短的句子（二字組少於 MIN_BIGRAMS）只要字都出現在某則長記憶裡就會拿到滿分，一律不併（審查 2026-11-24）
const MIN_BIGRAMS = 8;
/** 該併進哪一則（回傳 id），沒有就 null。只看兩週內、沒釘選的；類別要相同（舊資料沒類別就當同類）。 */
export function mergeTarget(item: { body: string; kind: MemKind | null }, rows: { id: string; body: string; kind?: string | null; created_at?: string; pinned_at?: string | null }[], now = Date.now()): string | null {
  if (bigrams(item.body).size < MIN_BIGRAMS) return null;
  let best: string | null = null, top = SAME_THING;
  for (const r of rows) {
    if (bigrams(r.body).size < MIN_BIGRAMS) continue;
    if (r.pinned_at) continue;
    if (now - Date.parse(r.created_at ?? "") > 14 * 86400_000) continue;
    if (item.kind && r.kind && item.kind !== r.kind) continue;
    const o = overlap(item.body, r.body);
    if (o >= top) { top = o; best = r.id; }
  }
  return best;
}

/* ── 喚醒與升格（六六 2026-11-27：「記得是要記得，但不要卡到陰一樣一直自己提起來」）──
   ・回憶不再整包塞進每句對話。他這個人（其人）與釘選的照常在；事件、狀態、短期筆記只有他這句話
     （連同前兩句）聊到了才帶進去。
   ・比對不用 overlap()：它除以較小的那一邊，「好的」「新家」兩個字就能拿滿分。
     這裡數的是「共同的內容二字組」有幾個，扣掉每則筆記都有的（護道、他說、今天……），至少 WAKE_MIN_SHARED 個才算。
   ・被喚醒那次角色回了多少 token 記在筆記上；每月看一次，累積到 PROMOTE_TOKENS 的才升格成回憶。 */
export const WAKE_MIN_SHARED = 3;
export const WAKE_MAX = 3;
export const PROMOTE_TOKENS = 800;      // 主力層一句回覆中位數約 210 token（2026-11 ai_usage）＝認真聊過約四次
export const NOTE_TTL_DAYS = 30;
const COMMON_BIGRAMS = new Set([
  "護道", "道人", "他說", "說自", "自己", "今天", "昨天", "明天", "覺得", "一個", "什麼", "沒有", "時候", "因為", "所以",
  "就是", "還是", "可以", "這個", "那個", "知道", "現在", "後來", "已經", "不是", "我們", "你們", "他們", "師父", "師傅",
  "怎麼", "這樣", "那樣", "真的", "一下", "一直", "不會", "不要", "要不", "然後", "如果", "感覺", "事情", "一點",
]);
function contentBigrams(t: string): Set<string> {
  const s = new Set<string>();
  const c = t.toLowerCase().replace(/[^一-鿿a-z0-9]/g, "");
  for (let i = 0; i + 2 <= c.length; i++) { const g = c.slice(i, i + 2); if (!COMMON_BIGRAMS.has(g)) s.add(g); }
  return s;
}
/** 他這句話（連同前兩句）喚醒了哪幾則；沒有就回空陣列。 */
export function wakeMatches<T extends { body: string }>(rows: T[], probe: string, max = WAKE_MAX): T[] {
  const P = contentBigrams(probe);
  if (P.size < WAKE_MIN_SHARED) return [];
  return rows
    .map((r) => { let n = 0; for (const g of contentBigrams(r.body)) if (P.has(g)) n++; return { r, n }; })
    .filter((x) => x.n >= WAKE_MIN_SHARED)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((x) => x.r);
}
/** 永遠在的回憶：釘選的、他這個人。其餘（事件、狀態）要被喚醒才給。 */
export const alwaysOn = (m: MemRow, now = Date.now()) => (!!m.pinned_at || kindOf(m) === "trait") && !isDormant(m, now);
