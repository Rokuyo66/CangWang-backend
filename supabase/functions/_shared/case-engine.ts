// _shared/case-engine.ts — 卦案局內狀態機。
//
// 純函數：applyAction(舊狀態) → 新狀態，不改參數、不碰 I/O、不呼叫 AI。
// 這一層決定「玩家做了什麼、世界因此變成什麼樣」；AI 之後只負責把這裡吐出的
// 結構化結果演繹成文字。現階段完全不接 AI，直接用案件檔的文本槽——
// 這樣才驗得出「骨架本身好不好玩」，而不是驗 AI 的包裝能力。
//
// 進度規則一律由伺服器判定（同 interpret 的既有做法）：客戶端只送「我做了什麼」，
// 不送「我因此得到什麼」。RunState 可整包存進 case_runs.state。

import type { CaseState } from "./case.ts";
import type { CaseFile, ClueFile, NpcFile, ObjectFile } from "./case-schema.ts";

/* ═══════════════ 狀態 ═══════════════ */

export interface LogEntry {
  clock: string;  // 世界時間 HH:MM
  kind: "move" | "search" | "inspect" | "talk" | "companion" | "gain" | "world" | "system";
  text: string;
}

export interface RunState {
  caseId: string;
  companion: string | null;   // daoshi_m／daoshi_f／lingshou／null＝獨自
  minute: number;             // 世界時間（當日 00:00 起算之分鐘）
  startMinute: number;
  region: number;
  clues: string[];            // 已取得線索（含道具）
  searched: number[];         // 已搜索過的區
  seen: string[];             // 已查看過的物件 id
  talked: string[];           // 已對話過的 npc id
  heard: string[];            // 已聽過的 NPC 台詞，鍵為 `${npcId}#${句次}`
  compFinds: string[];        // 同行角色取得之線索
  lostClues: string[];        // 因時限錯失、本局再也拿不到的線索
  worldMarks: string[];       // 已觸發的時間事件
  /** 同行角色外出中。null＝人在你身邊。
   *
   *  玩家不知道他去了哪一區——told 決定他出門前有沒有順口說。這不是省事，
   *  是玩法本身：不知道他在哪，你才會為了「要不要自己也去後山」猶豫；
   *  兩人撞在同一區也不特別處理，反正有些東西本來就只有他找得到。 */
  errand: { region: number; returnAt: number; told: boolean } | null;
  log: LogEntry[];
  ended: boolean;
}

/* 行動時間成本（規格書第七節）。
   companion 是「開口拜託一句」的成本，不是他跑一趟的時間——
   那一趟走的是世界時間，玩家在這期間可以做別的事。 */
export const COST = { move: 5, search: 3, inspect: 1, talk: 5, companion: 1 } as const;

/** 一刻。角色台詞裡講的也是這個數字，機制與口語不能各說各話。 */
export const ERRAND_MINUTES = 15;

export type Action =
  | { kind: "move"; to: number }
  | { kind: "search" }
  | { kind: "inspect"; objectId: string }
  | { kind: "talk"; npcId: string }
  | { kind: "companion" }
  | { kind: "end" };

export interface ActionOption { action: Action; label: string; cost: number; note?: string }

/* ═══════════════ 世界時間 ═══════════════ */

export const clockOf = (minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** 時間推進造成的世界變化。同一張地圖靠這個產生不同體驗，不需新美術。 */
const WORLD_EVENTS: { at: number; id: string; text: string }[] = [
  { at: 20 * 60, id: "w_home", text: "院子裡的人陸續回屋去了。村子安靜下來。" },
  { at: 21 * 60, id: "w_incense", text: "廢廟那頭飄來香火味——有人這時候還去上香。" },
  { at: 22 * 60, id: "w_fog", text: "山路起霧了。往後山的路開始看不清楚。" },
  { at: 23 * 60, id: "w_leave", text: "一個人影從村長家後門出去，往後山方向沒入霧裡。" },
];

/* ═══════════════ 投射結果 → 區域呈現 ═══════════════ */

export interface RegionView {
  pos: number; name: string; image: string; dir: string; beast: string; mood: string;
  paragraphs: string[];        // 依當局投射組出的描述段落
  roles: string[];             // 世／應／用神／元神／忌神
  objects: { obj: ObjectFile; seen: boolean; blocked: string | null }[];
  npcs: { id: string; name: string; talked: boolean }[];
  searched: boolean;
}

/** onKey 取用的退讓鏈：作者沒填該代價時，退到語意最接近的已填槽，都沒有就略過。 */
const KEY_FALLBACK: Record<string, string[]> = {
  open: ["open", "normal"],
  normal: ["normal", "open"],
  stirring: ["stirring", "open", "normal"],
  timed: ["timed", "normal", "open"],
  sealed: ["sealed", "timed", "normal"],
  void: ["void", "sealed", "timed", "normal"],
  broken: ["broken", "normal"],
  contested: ["contested", "normal", "open"],
  hidden: ["hidden", "sealed", "normal"],
  hiddenHard: ["hiddenHard", "hidden", "sealed", "normal"],
  noCase: ["noCase"],
};

function keyText(cf: CaseFile, st: CaseState, pos: number): string | null {
  const r = cf.regions.find((x) => x.pos === pos);
  if (!r) return null;
  for (const k of KEY_FALLBACK[st.access] ?? [st.access]) {
    const t = r.onKey[k as keyof typeof r.onKey];
    if (t?.trim()) return t;
  }
  return null;
}

/** 關鍵物件：關鍵線索區裡第一個會給線索的物件。卦決定它多難拿，不決定它在不在。 */
function keyObjectId(cf: CaseFile, st: CaseState): string | null {
  if (st.key.pos == null) return null;
  const r = cf.regions.find((x) => x.pos === st.key.pos);
  return r?.objects.find((o) => o.clue)?.id ?? null;
}

/** 取得阻礙：回傳擋住的理由，null＝可取。代價（access）只作用在關鍵物件上。 */
export function blockedReason(
  cf: CaseFile, st: CaseState, run: RunState, o: ObjectFile,
): string | null {
  const clue = o.clue ? cf.clues.find((c) => c.id === o.clue) : null;
  if (clue) {
    const missing = (clue.requires ?? []).filter((r) => !run.clues.includes(r));
    if (missing.length) {
      const names = missing.map((m) => cf.clues.find((c) => c.id === m)?.name ?? m);
      return `你還看不出這代表什麼——得先弄清楚：${names.join("、")}`;
    }
  }
  if (o.needsItem && !run.clues.includes(o.needsItem)) {
    const it = cf.clues.find((c) => c.id === o.needsItem);
    return `徒手辦不到，需要${it?.name ?? o.needsItem}。`;
  }
  if (o.clue && run.lostClues.includes(o.clue)) return "來遲了。原本在這裡的東西已經不在了。";

  if (o.id === keyObjectId(cf, st)) {
    switch (st.access) {
      case "void":
        return "怎麼找都是空的。這一趟，這條線索不在你能拿到的地方。";
      case "timed": {
        const due = run.startMinute + 60;
        if (run.minute < due) return `現在還取不出來，得再等一陣（約 ${clockOf(due)} 之後）。`;
        return null;
      }
      case "sealed":
        if (!cf.clues.some((c) => c.kind === "item" && run.clues.includes(c.id)))
          return "被封死了，徒手撬不開——手上得先有個能使力的東西。";
        return null;
      case "hidden":
      case "hiddenHard": {
        const fly = st.key.flyPos;
        if (fly && !run.searched.includes(fly))
          return `這東西藏在別的事底下。得先把第 ${fly} 區翻過一遍，才掀得開。`;
        return null;
      }
      default:
        return null;
    }
  }
  return null;
}

export function regionView(cf: CaseFile, st: CaseState, run: RunState): RegionView {
  const pos = run.region;
  const rf = cf.regions.find((x) => x.pos === pos)!;
  const rs = st.regions.find((x) => x.pos === pos)!;
  const searched = run.searched.includes(pos);

  const paragraphs = [rf.desc];
  if (st.key.pos === pos) { const t = keyText(cf, st, pos); if (t) paragraphs.push(t); }
  if (st.startPos === pos && rf.onStart) paragraphs.push(rf.onStart);
  if (st.rivalPos === pos && rf.onRival) paragraphs.push(rf.onRival);
  if (st.support.yuanPos.includes(pos) && rf.onYuan) paragraphs.push(rf.onYuan);
  if (st.support.jiPos.includes(pos) && rf.onJi) paragraphs.push(rf.onJi);

  const npcHere = cf.npcs.filter((n) => n.region === pos)
    .filter((n) => !(n.id === "n_brother" && run.worldMarks.includes("w_leave")));

  return {
    pos, name: rf.name, image: rf.image, dir: rs.dir, beast: rs.beast, mood: rs.mood,
    paragraphs, roles: rs.roles, searched,
    objects: rf.objects.map((obj) => ({
      obj, seen: run.seen.includes(obj.id), blocked: blockedReason(cf, st, run, obj),
    })),
    npcs: npcHere.map((n) => ({ id: n.id, name: n.name, talked: run.talked.includes(n.id) })),
  };
}

/* ═══════════════ 開局 ═══════════════ */

export function startRun(cf: CaseFile, st: CaseState, companion: string | null, nowHour?: number): RunState {
  const hour = cf.entryHour ?? nowHour ?? 19;
  const minute = hour * 60 + 30;
  const run: RunState = {
    caseId: cf.id, companion, minute, startMinute: minute,
    region: st.startPos,  // 世爻 ＝ 玩家立足之處
    clues: [], searched: [], seen: [], talked: [], heard: [], compFinds: [], lostClues: [],
    worldMarks: [], errand: null, log: [], ended: false,
  };
  const compName = companion ? COMPANION_NAME[companion] ?? companion : null;
  push(run, "system", `【${cf.title}】${cf.question}`);
  push(run, "system", `起卦：${st.benName}${st.turnTo ? ` 之 ${st.turnTo}` : ""}（${st.palace}宮${st.guaType}）　主軸方位 ${st.palaceDir}`);
  push(run, "system", compName ? `同行：${compName}` : "獨自前往。");
  push(run, "move", `你落腳在${cf.regions.find((r) => r.pos === st.startPos)!.name}。`);
  return run;
}

export const COMPANION_NAME: Record<string, string> = {
  daoshi_m: "師兄", daoshi_f: "師妹", lingshou: "觀喵",
};

function push(run: RunState, kind: LogEntry["kind"], text: string) {
  run.log.push({ clock: clockOf(run.minute), kind, text });
}

/* ═══════════════ 可選行動 ═══════════════ */

export function options(cf: CaseFile, st: CaseState, run: RunState): ActionOption[] {
  if (run.ended) return [];
  const out: ActionOption[] = [];
  const view = regionView(cf, st, run);

  if (!view.searched)
    out.push({ action: { kind: "search" }, label: `搜索${view.name}`, cost: COST.search });

  for (const { obj, seen, blocked } of view.objects) {
    if (!view.searched) continue;
    out.push({
      action: { kind: "inspect", objectId: obj.id },
      label: `查看　${obj.name}`, cost: COST.inspect,
      note: seen ? "已看過" : blocked ?? undefined,
    });
  }

  // 「談過了」不等於「問完了」——拿到新證據後他可能就肯講了。
  // 不標出來的話，玩家不會知道該回頭找誰，證據撬口供這條路等於沒開。
  for (const n of view.npcs) {
    const npc = cf.npcs.find((x) => x.id === n.id)!;
    const hasNew = freshLines(cf, run, npc).length > 0;
    out.push({
      action: { kind: "talk", npcId: n.id },
      label: `攀談　${n.name}`,
      cost: COST.talk,
      note: !n.talked ? undefined : hasNew ? "他還有話" : "已談過",
    });
  }

  // 外出中就不出這顆鈕——人不在你身邊，沒有人可以拜託。
  // 剩餘時間由畫面另外顯示，不塞回選項列表裡假裝是個可按的東西。
  if (run.companion && !run.errand) {
    const comp = cf.companions.find((c) => c.id === run.companion);
    const left = (comp?.clues ?? []).filter((c) => !run.clues.includes(c) && !run.compFinds.includes(c));
    out.push({
      action: { kind: "companion" },
      label: `請${COMPANION_NAME[run.companion]}去看看`, cost: COST.companion,
      note: left.length ? undefined : "他能找的都找過了",
    });
  }

  for (const r of cf.regions) {
    if (r.pos === run.region) continue;
    out.push({ action: { kind: "move", to: r.pos }, label: `前往　${r.name}`, cost: COST.move });
  }

  out.push({ action: { kind: "end" }, label: "結案（收工回觀）", cost: 0 });
  return out;
}

/* ═══════════════ 執行行動 ═══════════════ */

/** 由局面狀態衍生的偽亂數：同一個盤面重跑必得同一份結果，除錯時才追得回去。 */
function roll(run: RunState, salt: number): number {
  const x = Math.sin((run.minute + salt * 97 + run.clues.length * 13) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function advance(cf: CaseFile, st: CaseState, run: RunState, mins: number) {
  const before = run.minute;
  run.minute += mins;

  // 同行角色歸來：時間跨過歸期就觸發，玩家人在哪一區都一樣——他是回來找你的
  if (run.errand && before < run.errand.returnAt && run.minute >= run.errand.returnAt) {
    returnFromErrand(cf, st, run);
  }

  for (const ev of WORLD_EVENTS)
    if (before < ev.at && run.minute >= ev.at && !run.worldMarks.includes(ev.id)) {
      run.worldMarks.push(ev.id);
      push(run, "world", ev.text);
    }
  // contested：忌神旺動剋用，關鍵線索正在被毀，過時不候
  if (st.access === "contested" && st.key.pos != null) {
    const deadline = run.startMinute + 45;
    const keyObj = keyObjectId(cf, st);
    const keyClue = keyObj ? cf.regions.flatMap((r) => r.objects).find((o) => o.id === keyObj)?.clue : null;
    if (keyClue && run.minute >= deadline && !run.clues.includes(keyClue) && !run.lostClues.includes(keyClue)) {
      run.lostClues.push(keyClue);
      push(run, "world", "來不及了——有人趕在你前頭把那處清乾淨了。");
    }
  }
}

/** 歸來。帶得回東西就給，空手也要有話講——只有成功才有內容的話，失敗就只是靜音。 */
function returnFromErrand(cf: CaseFile, st: CaseState, run: RunState) {
  const errand = run.errand!;
  run.errand = null;
  const name = COMPANION_NAME[run.companion!] ?? run.companion!;
  const comp = cf.companions.find((c) => c.id === run.companion);
  const where = cf.regions.find((r) => r.pos === errand.region)?.name ?? "";

  const pick = (comp?.clues ?? []).find((cid) => {
    const c = cf.clues.find((x) => x.id === cid);
    if (!c || c.region !== errand.region) return false;
    if (run.clues.includes(cid) || run.compFinds.includes(cid)) return false;
    return (c.requires ?? []).every((r) => run.clues.includes(r));
  });

  if (!pick) {
    push(run, "companion", errand.told
      ? `${name}回來了，兩手空空。「${where}那頭沒什麼可看的。」`
      : `${name}回來了，兩手空空。你問他去了哪，他只說「繞了一圈」。`);
    return;
  }

  run.compFinds.push(pick);
  push(run, "companion", `${name}回來了，臉色與出門時不同。「${where}，你得聽我說。」`);
  gainClue(cf, run, st, pick, `（${name}帶回來的）`);
}

/** 此刻這位 NPC 願意說、而玩家還沒聽過的話。
 *
 *  一句話要出得來，三個條件都得成立：沒聽過、needs 的線索都在手上、
 *  它要給的那條線索本身的 requires 也滿足。
 *  最後一項不能省——requires 是線索自身的前提，不因為改由誰口中說出而失效。 */
function freshLines(cf: CaseFile, run: RunState, npc: NpcFile) {
  run.heard ??= [];   // 舊存檔沒有這個欄位
  return npc.says
    .map((line, i) => ({ line, key: `${npc.id}#${i}` }))
    .filter(({ line, key }) => {
      if (run.heard.includes(key)) return false;
      if (!(line.needs ?? []).every((n) => run.clues.includes(n))) return false;
      if (line.clue) {
        const c = cf.clues.find((x) => x.id === line.clue);
        if (c && !(c.requires ?? []).every((r) => run.clues.includes(r))) return false;
      }
      return true;
    });
}

function gainClue(cf: CaseFile, run: RunState, st: CaseState, clueId: string, via: string) {
  if (run.clues.includes(clueId)) return;
  const c = cf.clues.find((x) => x.id === clueId);
  if (!c) return;
  run.clues.push(clueId);
  const broken = st.access === "broken" && st.key.pos === c.region;
  const tail = broken ? "（殘缺不全，只認得出一半）" : "";
  push(run, "gain", `${c.kind === "item" ? "取得" : "看出"}【${c.name}】${via}　${c.text}${tail}`);
  if (st.access === "stirring" && st.key.pos === c.region)
    push(run, "gain", "而且不只如此——這處早就被人動過，只是表面看不出來。");
}

export function applyAction(cf: CaseFile, st: CaseState, prev: RunState, a: Action): RunState {
  const run: RunState = structuredClone(prev);
  if (run.ended) return run;

  switch (a.kind) {
    case "move": {
      advance(cf, st, run, COST.move);
      run.region = a.to;
      push(run, "move", `你走到${cf.regions.find((r) => r.pos === a.to)!.name}。`);
      break;
    }
    case "search": {
      advance(cf, st, run, COST.search);
      if (!run.searched.includes(run.region)) run.searched.push(run.region);
      const rf = cf.regions.find((r) => r.pos === run.region)!;
      push(run, "search", `你把${rf.name}翻了一遍。${rf.objects.map((o) => o.name).join("、")}——都值得再看看。`);
      break;
    }
    case "inspect": {
      const rf = cf.regions.find((r) => r.pos === run.region)!;
      const obj = rf.objects.find((o) => o.id === a.objectId);
      if (!obj) break;
      advance(cf, st, run, COST.inspect);
      if (!run.seen.includes(obj.id)) run.seen.push(obj.id);
      const blocked = blockedReason(cf, st, run, obj);
      push(run, "inspect", `${obj.name}：${obj.desc}`);
      if (blocked) push(run, "system", blocked);
      else if (obj.clue) gainClue(cf, run, st, obj.clue, `（${obj.name}）`);
      break;
    }
    case "talk": {
      const npc = cf.npcs.find((n) => n.id === a.npcId);
      if (!npc) break;
      advance(cf, st, run, COST.talk);
      if (!run.talked.includes(npc.id)) run.talked.push(npc.id);
      const fresh = freshLines(cf, run, npc);
      if (!fresh.length) {
        push(run, "talk", `${npc.name}把方才的話又說了一遍。沒有新的東西——除非你手上多點什麼。`);
        break;
      }
      for (const { line, key } of fresh) {
        run.heard.push(key);
        push(run, "talk", `${npc.name}：${line.text}`);
        if (line.clue) gainClue(cf, run, st, line.clue, `（${npc.name}說的）`);
      }
      break;
    }
    case "companion": {
      if (!run.companion || run.errand) break;
      const comp = cf.companions.find((c) => c.id === run.companion);
      const name = COMPANION_NAME[run.companion];
      if (!comp?.regions.length) break;

      // 他自己挑去哪：優先挑「那一區還有他拿得到、且前置已滿足的線索」，
      // 沒有這種區就隨便走一趟。玩家看不到這個判斷。
      const worth = comp.regions.filter((pos) =>
        comp.clues.some((cid) => {
          const c = cf.clues.find((x) => x.id === cid);
          return c && c.region === pos && !run.clues.includes(cid) && !run.compFinds.includes(cid) &&
            (c.requires ?? []).every((r) => run.clues.includes(r));
        }));
      const pool = worth.length ? worth : comp.regions;
      const target = pool[Math.floor(roll(run, 1) * pool.length)];
      const told = roll(run, 2) < 0.5;   // 他不一定會說去哪

      advance(cf, st, run, COST.companion);
      run.errand = { region: target, returnAt: run.minute + ERRAND_MINUTES, told };
      const where = cf.regions.find((r) => r.pos === target)?.name ?? "";
      push(run, "companion", told
        ? `${name}：「我往${where}走一趟，一刻後歸來，你莫亂跑。」`
        : `${name}：「我去去就回，一刻。」他沒說要往哪走，轉身就沒入夜色裡了。`);
      break;
    }
    case "end": {
      run.ended = true;
      push(run, "system", "你收拾東西，離開了這座村子。");
      break;
    }
  }
  return run;
}

/* ═══════════════ 案件回顧（規格書第十七節） ═══════════════ */

export interface Review {
  title: string; spent: number; clock: string;
  companion: string | null; companionFinds: number; companionTotal: number;
  found: ClueFile[]; missed: ClueFile[]; lost: ClueFile[];
  solved: boolean;
  gua: { ben: string; bian: string | null; palace: string; access: string; keyPos: number | null };
  truthShown: boolean;
}

/** 破案條件：找到地窖入口。找不到不代表真相不同——真相一直都在那裡。 */
export const SOLVE_CLUE = "c_cellar";

export function review(cf: CaseFile, st: CaseState, run: RunState): Review {
  const byId = new Map(cf.clues.map((c) => [c.id, c]));
  const found = run.clues.map((c) => byId.get(c)!).filter(Boolean);
  const lost = run.lostClues.map((c) => byId.get(c)!).filter(Boolean);
  const missed = cf.clues.filter((c) => !run.clues.includes(c.id) && !run.lostClues.includes(c.id));
  const comp = cf.companions.find((c) => c.id === run.companion);
  return {
    title: cf.title,
    spent: run.minute - run.startMinute,
    clock: clockOf(run.minute),
    companion: run.companion ? COMPANION_NAME[run.companion] : null,
    companionFinds: run.compFinds.length,
    companionTotal: comp?.clues.length ?? 0,
    found, missed, lost,
    solved: run.clues.includes(SOLVE_CLUE),
    gua: {
      ben: st.benName, bian: st.turnTo, palace: `${st.palace}宮${st.guaType}`,
      access: st.access, keyPos: st.key.pos,
    },
    truthShown: run.clues.includes(SOLVE_CLUE),
  };
}
