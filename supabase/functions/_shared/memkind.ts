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
const SELF_SUBJECT = /^(師妹|大師兄|師兄|觀喵|觀貓|喵師傅|你)/;
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
export function arrangeMemories(rows: MemRow[], age: (iso?: string) => string, now = Date.now()): string {
  const live = rows.filter((m) => !isDormant(m, now));
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

/** 解析彙整輸出：每行「類別｜M/D｜內容」。認不出格式的行照舊存成一則（類別留空，讀時再判）。
 *  M/D 補年份：取不晚於這批對話最後一天的那一年（跨年的 12/31 不會被當成明年）。 */
export function parseMemoryLines(text: string, batchLastIso?: string): { body: string; kind: MemKind | null; happened_on: string | null }[] {
  const last = tw(batchLastIso) ?? new Date(Date.now() + 8 * 3600_000);
  const fallbackDay = last.toISOString().slice(0, 10);
  const out: { body: string; kind: MemKind | null; happened_on: string | null }[] = [];
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/^[・\-*•\s]+/, "").trim();
    if (!line || /^無新記憶[。.]?$/.test(line)) continue;
    const m = line.match(/^(其人|事件|狀態)\s*[|｜]\s*([^|｜]*?)\s*[|｜]\s*(.+)$/);
    if (!m) { out.push({ body: line.slice(0, 160), kind: null, happened_on: fallbackDay }); continue; }
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
const MIN_BATCH = 40;
const STALE_MS = 7 * 86400_000;
const STALE_MIN = 8;
const HARD_CAP = 80;
const MAX_BATCH = 120;

/** 由舊到新的明細 → 這次要濃縮最舊的幾則（0＝先不收）。 */
export function condenseCount(msgs: { created_at?: string }[], now = Date.now()): number {
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

/* ── 帶進對話的明細從哪一則開始（六六 2026-10-12：不管隔多久，師妹都卡在那碗湯）──
   timeGapHint 只是一句「那是之前的事」，可前一場的明細照樣整串回灌，模型看到的最後幾則全是湯。
   新做法：這一場的全帶；前一場只在隔得不久（PREV_KEEP_MS 內）時帶最後兩則接個話頭；
   再久就一則都不帶——前一場的事交給回憶，不交給逐字稿。 */
const PREV_KEEP_MS = 12 * 3600_000;
const PREV_KEEP_N = 2;
export function sessionStart(msgs: { created_at?: string }[], now = Date.now()): number {
  if (!msgs.length) return 0;
  const at = (i: number) => Date.parse(msgs[i]?.created_at ?? "");
  let s: number;
  if (now - at(msgs.length - 1) >= SESSION_GAP_MS) s = msgs.length;      // 這句話開了新的一場
  else { s = msgs.length - 1; while (s > 0 && !(at(s) - at(s - 1) >= SESSION_GAP_MS)) s--; }
  if (s === 0) return 0;
  const began = s < msgs.length ? at(s) : now;
  const idle = began - at(s - 1);
  return idle < PREV_KEEP_MS ? Math.max(0, s - PREV_KEEP_N) : s;
}

/* ── 一直繞回同一件事（同上）：角色最近幾則都提、他卻沒接的詞 ──
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
      if (!/^[\u4e00-\u9fff]{3}$/.test(g) || FUNC.test(g) || seen.has(g)) continue;
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
   新寫的一則跟最近的某一則講的是同一件事（字面重疊夠多、類別相同），就把那一則改寫成新的，不另插一列。 */
const bigrams = (t: string) => { const s = new Set<string>(); const c = t.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ""); for (let i = 0; i + 2 <= c.length; i++) s.add(c.slice(i, i + 2)); return s; };
export function overlap(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return n / Math.min(A.size, B.size);
}
export const SAME_THING = 0.35;
/** 該併進哪一則（回傳 id），沒有就 null。只看兩週內、沒釘選的；類別要相同（舊資料沒類別就當同類）。 */
export function mergeTarget(item: { body: string; kind: MemKind | null }, rows: { id: string; body: string; kind?: string | null; created_at?: string; pinned_at?: string | null }[], now = Date.now()): string | null {
  let best: string | null = null, top = SAME_THING;
  for (const r of rows) {
    if (r.pinned_at) continue;
    if (now - Date.parse(r.created_at ?? "") > 14 * 86400_000) continue;
    if (item.kind && r.kind && item.kind !== r.kind) continue;
    const o = overlap(item.body, r.body);
    if (o >= top) { top = o; best = r.id; }
  }
  return best;
}
