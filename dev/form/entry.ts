// dev/form/entry.ts — 案件填表工具的瀏覽器接線。
//
// 這是給作者用的，不是給玩家用的。它做三件事：
//   ① 把 CaseFile 的每個欄位攤成表單，不必再手寫 TypeScript
//   ② 即時跑 validateCase()——線索成環、孤兒線索、角色搜不到自己該拿的線索，
//      這些錯誤在遊玩時表現為「玩家卡死但沒有報錯」，填的當下就要擋
//   ③ 即時跑覆蓋率，把「還沒填的槽」依實際機率排出來，並標出下一個該填哪個
//
// 效能上的關鍵取捨：覆蓋率的機率表只跟 useQin／entryHour／六區爻位有關，
// 跟你填了什麼字完全無關。所以機率表只在那幾個欄位變動時重算（兩萬局，約一秒），
// 打字時只重算「哪些槽有字」——那是純字串檢查，即時。
//
// 另一個取捨：打字時不重繪表單，只重繪右盤。整份重繪會讓游標跳掉、選字中斷。
// 表單只在結構變動（增刪線索／NPC／物件、摺疊區域）時才重建。
//
// 跑法：node dev/build-form.mjs  →  用瀏覽器開 dev/form.html

import { YAO_IMAGE } from "../../supabase/functions/_shared/case.ts";
import {
  validateCase, slotCoverage, ALL_ACCESS, VALID_USE_QIN, CHARACTER_IDS,
  type CaseFile, type RegionFile, type ClueFile, type NpcFile,
  type CompanionFile, type ObjectFile, type CoverageReport,
} from "../../supabase/functions/_shared/case-schema.ts";
import { HUANGCUN } from "../../supabase/functions/_shared/cases/huangcun.ts";
import { mountPlay } from "../shared/play-ui.ts";

const app = document.getElementById("app")!;
const STORE_KEY = "guaan.case.draft";

/* ═══════════════ 代價的白話與註解（與 case.ts 的定義同步） ═══════════════ */

const ACCESS_GLOSS: Record<string, string> = {
  open: "直接可得",
  normal: "平",
  timed: "蓄勢待發",
  void: "徹底無力",
  sealed: "被關住",
  broken: "線索殘毀",
  contested: "跟時間搶",
  stirring: "暗中已啟動",
  hidden: "先處理別的事",
  hiddenHard: "幾乎挖不出",
  noCase: "此卦不成案",
};

const ROLE_SLOTS = [
  ["onStart", "世·立足", "start"],
  ["onRival", "應·對手", "rival"],
  ["onYuan", "元神·助力", "yuan"],
  ["onJi", "忌神·阻力", "ji"],
] as const;

/* ═══════════════ 草稿 ═══════════════ */

function blankCase(): CaseFile {
  return {
    id: "", title: "", version: 1, question: "", useQin: "應",
    truth: "", brief: "", entryHour: null, voidPolicy: "allow",
    regions: [1, 2, 3, 4, 5, 6].map((pos): RegionFile => ({
      pos, name: "", image: YAO_IMAGE[pos - 1], desc: "", objects: [], onKey: {},
    })),
    npcs: [], clues: [], companions: [],
  };
}

function load(): CaseFile {
  // 撞版重載後留下的暫存最優先——那是還沒存成功的改動，丟了最痛
  try {
    const stash = sessionStorage.getItem(STORE_KEY);
    if (stash) { sessionStorage.removeItem(STORE_KEY); return JSON.parse(stash) as CaseFile; }
  } catch { /* 存取不到就算了 */ }

  // 線上版：草稿隨頁面一起發佈，換裝置打開就在
  try {
    const raw = document.getElementById("draft")?.textContent?.trim();
    if (raw && raw !== "null") return JSON.parse(raw) as CaseFile;
  } catch { /* 草稿壞掉不該擋住開啟 */ }

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as CaseFile;
  } catch { /* 壞掉的草稿不值得中斷開啟，直接當沒有 */ }

  return structuredClone(HUANGCUN) as CaseFile;
}

let cf: CaseFile = load();
let openRegion = 1;
let mode: "form" | "play" = "form";

let savedAt = "";
let saveErr = "";
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cf));
    const d = new Date();
    savedAt = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    saveErr = "";
  } catch {
    // 無痕視窗、file:// 下被鎖、或超出容量都會走到這裡。
    // 自動存檔沒了不該擋住填表，但必須講清楚——不然關掉分頁才發現全沒了。
    savedAt = "";
    saveErr = "⚠ 自動存檔失效，請自行「匯出 JSON」保存";
  }
}
function saveLabel(): string {
  return saveErr || (savedAt ? `已存 ${savedAt}` : "");
}

/* ═══════════════ 線上版：雲端存檔與存成檔案 ═══════════════ */

// 兩個能力都可能不在（本機開檔就一定沒有），一律當作可能為 null 來寫。
interface DownloadsCap { save(r: { filename: string; data: string }): Promise<unknown> }
interface ArtifactCap { publish(html: string): Promise<{ version: string }> }
const CAP: { artifact: ArtifactCap | null; downloads: DownloadsCap | null } =
  { artifact: null, downloads: null };

let cloudMsg = "";

async function initCaps() {
  const c = (globalThis as { claude?: { use?(n: string): Promise<unknown> } }).claude;
  if (!c?.use) return;
  CAP.artifact = await c.use("artifact").catch(() => null) as ArtifactCap | null;
  CAP.downloads = await c.use("downloads").catch(() => null) as DownloadsCap | null;
  render();
}

// 重建整頁原始碼。不能直接序列化現場 DOM——那裡面有 viewer session 狀態與
// 平台注入的 script。樣式與 bundle 各自從自己那顆標籤取原文，其餘由這裡寫死。
function pageSource(draftJson: string): string {
  const styles = document.getElementById("styles")?.textContent ?? "";
  const bundle = document.getElementById("bundle")?.textContent ?? "";
  // 內容裡若出現 </script 會提前關掉標籤；JSON 與 JS 字串裡的 <\/script 意義不變
  const safe = (s: string) => s.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>案件填表｜卦案</title>
<style id="styles">${styles}</style>
</head>
<body>
<div id="app"></div>
<script id="draft" type="application/json">${safe(draftJson)}</script>
<script id="bundle">${safe(bundle)}</script>
</body>
</html>
`;
}

async function cloudSave() {
  if (!CAP.artifact) return;
  cloudMsg = "存檔中…";
  paintStatus();
  // 撞版時整頁會被重載，JS 變數活不過去——先把稿子擱在 sessionStorage
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(cf)); } catch { /* 存不了就算了 */ }
  try {
    await CAP.artifact.publish(pageSource(JSON.stringify(cf)));
    try { sessionStorage.removeItem(STORE_KEY); } catch { /* 同上 */ }
    const d = new Date();
    cloudMsg = `已存到雲端 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    cloudMsg =
      code === "conflict" ? "另一處先存了，畫面即將重載——你這邊的改動已暫存，重載後還在" :
      code === "not_writer" || code === "not_granted" ? "這個視窗是唯讀的，存不了" :
      code === "rate_limited" ? "存得太密，等一下再存" :
      code === "too_large" ? "頁面太大，存不進去" :
      `存不進去（${code || (e as Error).message}）`;
  }
  paintStatus();
}

// 匯出。線上版走 downloads 能力（沙箱擋掉一般的 <a download>）；
// 該能力的副檔名白名單沒有 .ts，所以線上版一律加 .txt，存下來自己改名。
async function offerFile(base: string, ext: string, body: string) {
  if (CAP.downloads) {
    const filename = ext === "ts" ? `${base}.ts.txt` : `${base}.${ext}`;
    cloudMsg = "";
    paintStatus();
    try {
      await CAP.downloads.save({ filename, data: body });
      cloudMsg = `已交給你存成 ${filename}`;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      cloudMsg = code === "declined" ? "你取消了存檔" : `存檔失敗（${code || (e as Error).message}）`;
    }
    paintStatus();
    return;
  }
  download(`${base}.${ext}`, body);
}

function paintStatus() {
  const s = document.getElementById("savedAt");
  if (s) s.textContent = saveLabel();
  const c = document.getElementById("cloudMsg");
  if (c) c.textContent = cloudMsg;
}

/* ═══════════════ 路徑存取 ═══════════════ */

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}
function setPath(obj: unknown, path: string, val: unknown) {
  const ks = path.split(".");
  let o = obj as Record<string, unknown>;
  for (const k of ks.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[ks[ks.length - 1]] = val;
}

/* ═══════════════ 覆蓋率：機率表快取 ═══════════════ */

// 機率只取決於用神、進案時辰與六區爻位；填了什麼字不影響機率，只影響 filled。
let probCache: { key: string; rep: CoverageReport } | null = null;

function coverageKey(c: CaseFile): string {
  return [c.useQin, c.entryHour, c.regions.map((r) => r.pos).join(",")].join("|");
}

function coverage(): CoverageReport {
  const key = coverageKey(cf);
  if (!probCache || probCache.key !== key) probCache = { key, rep: slotCoverage(cf, 20000) };

  // 機率沿用快取，filled 依當下文字即時重算
  const byPos = new Map(cf.regions.map((r) => [r.pos, r]));
  const needs = probCache.rep.needs.map((n) => ({
    ...n, filled: Boolean(byPos.get(n.pos)?.onKey[n.access]?.trim()),
  }));
  const filledShare = needs.filter((n) => n.filled).reduce((s, n) => s + n.prob, 0);
  return { ...probCache.rep, needs, filledShare, missingShare: 1 - filledShare };
}

/* ═══════════════ 小工具 ═══════════════ */

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const pct = (p: number) => (p * 100).toFixed(1) + "%";

function field(label: string, note: string, path: string, kind: "text" | "area" | "select",
               opts?: { options?: string[]; rows?: number; hint?: string }): string {
  const v = getPath(cf, path);
  const val = v == null ? "" : String(v);
  let ctl: string;
  if (kind === "select") {
    ctl = `<select data-path="${path}">${(opts?.options ?? []).map((o) =>
      `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  } else if (kind === "area") {
    ctl = `<textarea data-path="${path}" rows="${opts?.rows ?? 3}">${esc(val)}</textarea>`;
  } else {
    ctl = `<input type="text" data-path="${path}" value="${esc(val)}">`;
  }
  return `<div class="f">
    <label><b>${esc(label)}</b>${note ? esc(note) : ""}</label>
    <div>${ctl}${opts?.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ""}</div>
  </div>`;
}

/* ═══════════════ 表單各段 ═══════════════ */

function secCase(): string {
  return `<div class="sec">
    <h2>案件層</h2>
    <p class="cap">填一次。真相寫死在這裡，AI 不得改寫，也不會因為玩家起出不同的卦而改變。</p>
    ${field("案名", "title", "title", "text")}
    ${field("識別碼", "id", "id", "text", { hint: "英數小寫，會成為檔名與資料庫索引，定了就別改" })}
    ${field("進案問句", "question", "question", "text", { hint: "固定不變，決定用神。玩家不能改問句——改了就是另一個案子" })}
    ${field("用神", "useQin", "useQin", "select", { options: VALID_USE_QIN })}
    ${field("客觀真相", "truth", "truth", "area", {
      rows: 5,
      hint: "玩家看得到。結案時原文呈現，要好看、可留白。只寫故事本身，不要寫給 AI 的交代",
    })}
    ${field("事件全貌", "brief", "brief", "area", {
      rows: 8,
      hint: "玩家永遠看不到，只給 AI 對齊事實用。誰在什麼時候做了什麼、動機、時間線、各人知道多少又隱瞞什麼——要窮盡、要無趣、要把矛盾寫死。缺這段，AI 只能從零碎素材猜，猜出來的前後會打架",
    })}
    ${field("進案時辰", "entryHour", "entryHour", "select", {
      options: ["依玩家當下", ...Array.from({ length: 24 }, (_, i) => String(i))],
      hint: "難度旋鈕。固定時辰會壓掉某些局（例如入墓），改這裡右盤的機率會整份重算",
    })}
    ${field("真空局處置", "voidPolicy", "voidPolicy", "select", {
      options: ["allow", "retry"],
      hint: "allow＝允許白跑，留下卦例紀錄；retry＝勸退重來，不消耗次數。定案一律 allow",
    })}
  </div>`;
}

function slotRow(ri: number, key: string, label: string, prob: number | null,
                 isNext: boolean): string {
  const path = `regions.${ri}.${key}`;
  const val = String(getPath(cf, path) ?? "");
  const done = Boolean(val.trim());
  const cls = ["slot", done ? "done" : "", isNext ? "next" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}">
    <div class="slot-l">
      <div class="slot-k">${esc(label)}</div>
      <div class="slot-p">${prob == null ? "" : pct(prob)}${isNext ? " ← 下一個" : ""}</div>
    </div>
    <textarea data-path="${path}" rows="2">${esc(val)}</textarea>
  </div>`;
}

function secRegions(rep: CoverageReport): string {
  const nextKey = rep.needs.find((n) => !n.filled);
  const probOf = (pos: number, access: string) =>
    rep.needs.find((n) => n.pos === pos && n.access === access)?.prob ?? 0;

  const body = cf.regions.map((r, ri) => {
    const filled = ALL_ACCESS.filter((a) => r.onKey[a]?.trim()).length;
    const covered = ALL_ACCESS.reduce((s, a) => s + (r.onKey[a]?.trim() ? probOf(r.pos, a) : 0), 0);
    const isOpen = openRegion === r.pos;

    const accessRows = ALL_ACCESS
      .map((a) => ({ a, p: probOf(r.pos, a) }))
      .sort((x, y) => y.p - x.p)
      .map(({ a, p }) => slotRow(ri, `onKey.${a}`,
        `${a}　${ACCESS_GLOSS[a] ?? ""}`, p,
        Boolean(nextKey && nextKey.pos === r.pos && nextKey.access === a)))
      .join("");

    const roleRows = ROLE_SLOTS.map(([key, label, share]) =>
      slotRow(ri, key, label, rep.roleShare[share][r.pos - 1], false)).join("");

    return `<div class="reg" data-open="${isOpen ? 1 : 0}">
      <div class="reg-h" data-toggle="${r.pos}">
        <span class="pos mono">${r.pos} 爻</span>
        <span class="nm">${esc(r.name || "（未命名）")}</span>
        <span class="meter mono">代價 ${filled}/11　涵蓋 ${pct(covered)}　物件 ${r.objects.length}</span>
      </div>
      <div class="reg-b">
        ${field("區名", "name", `regions.${ri}.name`, "text")}
        ${field("爻位取象", "image", `regions.${ri}.image`, "text",
          { hint: `本爻定象：${YAO_IMAGE[r.pos - 1]}` })}
        ${field("基礎場景", "desc", `regions.${ri}.desc`, "area",
          { rows: 3, hint: "素材，不是最終文案。無論什麼卦都會出現的那一段" })}

        <h2 style="margin-top:16px">可調查物件</h2>
        <p class="cap">物件是取得線索的途徑。沒有物件指向的線索＝玩家永遠拿不到，右盤會報錯。</p>
        ${r.objects.map((o, oi) => itemObject(ri, oi, o)).join("")}
        <button class="add" data-add="object" data-ri="${ri}">＋ 加一個物件</button>

        <h2 style="margin-top:18px">代價表現</h2>
        <p class="cap">同一區、同一條線索，卦不同則取得的代價不同。百分比為實測機率，由高至低排。</p>
        ${accessRows}

        <h2 style="margin-top:18px">角色表現</h2>
        <p class="cap">此區在本局擔任該角色時追加的一段。不填不報錯，填了就是白撿的層次。</p>
        ${roleRows}
      </div>
    </div>`;
  }).join("");

  return `<div class="sec">
    <h2>六區</h2>
    <p class="cap">六區綁六爻爻位，不能增減——地圖就是一張卦盤。點標題列展開。</p>
    ${body}
  </div>`;
}

function itemObject(ri: number, oi: number, o: ObjectFile): string {
  const clueOpts = ["（不給線索）", ...cf.clues.map((c) => c.id)];
  const itemOpts = ["（不需道具）", ...cf.clues.filter((c) => c.kind === "item").map((c) => c.id)];
  return `<div class="item">
    <div class="item-h"><span class="n">物件 ${oi + 1}</span>
      <button class="x" data-del="object" data-ri="${ri}" data-i="${oi}">移除</button></div>
    ${field("識別碼", "id", `regions.${ri}.objects.${oi}.id`, "text")}
    ${field("名稱", "name", `regions.${ri}.objects.${oi}.name`, "text")}
    ${field("描述", "desc", `regions.${ri}.objects.${oi}.desc`, "area", { rows: 2 })}
    ${field("給出線索", "clue", `regions.${ri}.objects.${oi}.clue`, "select", { options: clueOpts })}
    ${field("需先持有", "needsItem", `regions.${ri}.objects.${oi}.needsItem`, "select",
      { options: itemOpts, hint: "只能指向 kind＝item 的線索——知識撬不開門" })}
  </div>`;
}

function secClues(): string {
  const body = cf.clues.map((c, i) => `<div class="item">
    <div class="item-h"><span class="n">線索 ${i + 1}</span>
      <button class="x" data-del="clue" data-i="${i}">移除</button></div>
    ${field("識別碼", "id", `clues.${i}.id`, "text")}
    ${field("名稱", "name", `clues.${i}.name`, "text")}
    ${field("所在區", "region", `clues.${i}.region`, "select", { options: ["1", "2", "3", "4", "5", "6"] })}
    ${field("種類", "kind", `clues.${i}.kind`, "select", { options: ["knowledge", "item"] })}
    ${field("內文", "text", `clues.${i}.text`, "area", { rows: 3 })}
    ${field("前置線索", "requires", `clues.${i}.requires`, "text",
      { hint: "以逗號分隔的線索識別碼；成環右盤會擋下" })}
  </div>`).join("");

  return `<div class="sec">
    <h2>線索</h2>
    <p class="cap">knowledge＝你知道了什麼；item＝你手上有什麼（可攜帶、可撬、可出示）。共 ${cf.clues.length} 條。</p>
    ${body}
    <button class="add" data-add="clue">＋ 加一條線索</button>
  </div>`;
}

function secNpcs(): string {
  const body = cf.npcs.map((n, i) => `<div class="item">
    <div class="item-h"><span class="n">NPC ${i + 1}</span>
      <button class="x" data-del="npc" data-i="${i}">移除</button></div>
    ${field("識別碼", "id", `npcs.${i}.id`, "text")}
    ${field("名稱", "name", `npcs.${i}.name`, "text")}
    ${field("所在區", "region", `npcs.${i}.region`, "select", { options: ["1", "2", "3", "4", "5", "6"] })}
    ${field("聲口", "voice", `npcs.${i}.voice`, "area",
      { rows: 3, hint: "唯一餵給 AI 的性格來源。寫他怎麼說話、避談什麼、什麼會讓他鬆口。這是導演指示，不是台詞" })}
    <div class="sub">
      <div class="sub-h">他會說的話（依序判定，條件滿足且沒聽過才出）</div>
      ${(n.says ?? []).map((_, j) => `<div class="line">
        <div class="item-h"><span class="n">第 ${j + 1} 句</span>
          <button class="x" data-del="say" data-i="${i}" data-j="${j}">移除</button></div>
        ${field("內容", "text", `npcs.${i}.says.${j}.text`, "area",
          { rows: 2, hint: "這句要傳達的事實。素材不是台詞——AI 依聲口演繹" })}
        ${field("要先有", "needs", `npcs.${i}.says.${j}.needs`, "text",
          { hint: "逗號分隔的線索識別碼。留空＝一開口就說。「沒證據就撬不開他的口」靠這欄" })}
        ${field("說了會給", "clue", `npcs.${i}.says.${j}.clue`, "text",
          { hint: "線索識別碼。留空＝只是反應或場面話，不給新資訊" })}
      </div>`).join("")}
      <button class="add sm" data-add="say" data-i="${i}">＋ 加一句</button>
    </div>
  </div>`).join("");

  return `<div class="sec">
    <h2>NPC</h2>
    <p class="cap">村民、關係人。共 ${cf.npcs.length} 位。對話是全案唯一會即時生成的部分。
      每個人至少要有一句話——開不了口的 NPC，玩家攀談只會得到空氣。</p>
    ${body}
    <button class="add" data-add="npc">＋ 加一位 NPC</button>
  </div>`;
}

function secCompanions(): string {
  const NAME: Record<string, string> = { daoshi_m: "師兄", daoshi_f: "師妹", lingshou: "觀喵" };
  const body = CHARACTER_IDS.map((id) => {
    const i = cf.companions.findIndex((c) => c.id === id);
    if (i < 0) {
      return `<div class="item">
        <div class="item-h"><span class="n">${esc(NAME[id])}　${esc(id)}</span>
          <button class="x" data-add="companion" data-cid="${id}">啟用</button></div>
        <p class="cap" style="margin:0">未啟用——此案不能帶他進去。</p>
      </div>`;
    }
    return `<div class="item">
      <div class="item-h"><span class="n">${esc(NAME[id])}　${esc(id)}</span>
        <button class="x" data-del="companion" data-i="${i}">停用</button></div>
      ${field("可搜索區", "regions", `companions.${i}.regions`, "text",
        { hint: "以逗號分隔的爻位，例如 1,2,5" })}
      ${field("可取得線索", "clues", `companions.${i}.clues`, "text",
        { hint: "以逗號分隔；AI 不得創造清單外的線索。線索必須落在他搜索得到的區" })}
      ${field("觸發條件", "trigger", `companions.${i}.trigger`, "area", { rows: 2 })}
    </div>`;
  }).join("");

  return `<div class="sec">
    <h2>同行</h2>
    <p class="cap">玩家進案前三選一或獨自前往。同一張地圖，帶不同人走出來的東西不一樣。</p>
    ${body}
  </div>`;
}

/* ═══════════════ 右盤 ═══════════════ */

function sidePanel(rep: CoverageReport): string {
  const errs = validateCase(cf);
  const todo = rep.needs.filter((n) => !n.filled);
  let cum = rep.filledShare;
  const rows = todo.slice(0, 14).map((n) => {
    cum += n.prob;
    const rf = cf.regions.find((r) => r.pos === n.pos);
    return `<button class="todo" data-jump="${n.pos}">
      <span class="p">${pct(n.prob)}</span>
      <span>${n.pos} ${esc(rf?.name || "")}　${esc(n.access)}</span>
      <span class="cum">→ ${pct(cum)}</span>
    </button>`;
  }).join("");

  const rest = todo.length - 14;

  return `
  <div class="card">
    <h3>結構驗證</h3>
    ${errs.length
      ? errs.map((e) => `<p class="err">・${esc(e)}</p>`).join("")
      : `<p class="ok" style="margin:0;font-size:13px">✅ 通過——沒有死鎖、孤兒線索或搆不到的指向。</p>`}
  </div>

  <div class="card">
    <h3>文本槽覆蓋</h3>
    <div class="big">${pct(rep.filledShare)}</div>
    <div class="bar"><i style="width:${(rep.filledShare * 100).toFixed(1)}%"></i></div>
    <p class="dim" style="margin:0 0 10px;font-size:12px">
      已填的槽涵蓋這麼多比例的局；還有 ${todo.length} 個未填槽漏掉 ${pct(rep.missingShare)}。
      樣本 ${rep.samples} 局，固定種子可重現。
    </p>
    ${rows}
    ${rest > 0 ? `<p class="dim" style="margin:8px 0 0;font-size:11px">…另有 ${rest} 個更低機率的組合</p>` : ""}
  </div>

  <div class="card">
    <h3>統計</h3>
    <p class="dim mono" style="margin:0;font-size:12px">
      區 ${cf.regions.length}　物件 ${cf.regions.reduce((s, r) => s + r.objects.length, 0)}<br>
      線索 ${cf.clues.length}（道具 ${cf.clues.filter((c) => c.kind === "item").length}）<br>
      NPC ${cf.npcs.length}　同行 ${cf.companions.length}<br>
      真相 ${cf.truth.length} 字　事件全貌 ${(cf.brief ?? "").length} 字
    </p>
    ${(cf.brief ?? "").trim() ? "" :
      `<p class="err" style="margin-top:8px">・事件全貌還空著——AI 生成時沒有事實可對齊</p>`}
  </div>`;
}

/* ═══════════════ 匯出 ═══════════════ */

function toTS(): string {
  const q = (s: string) => JSON.stringify(s ?? "");
  const obj = (o: ObjectFile) => `        { id: ${q(o.id)}, name: ${q(o.name)}, desc: ${q(o.desc)}` +
    (o.clue ? `, clue: ${q(o.clue)}` : "") + (o.needsItem ? `, needsItem: ${q(o.needsItem)}` : "") + " },";

  const region = (r: RegionFile) => {
    const onKey = ALL_ACCESS.filter((a) => r.onKey[a]?.trim())
      .map((a) => `        ${a}: ${q(r.onKey[a]!)},`).join("\n");
    const roles = ROLE_SLOTS.filter(([k]) => (r as unknown as Record<string, string>)[k]?.trim())
      .map(([k]) => `      ${k}: ${q((r as unknown as Record<string, string>)[k])},`).join("\n");
    return `    {
      pos: ${r.pos},
      name: ${q(r.name)},
      image: ${q(r.image)},
      desc: ${q(r.desc)},
      objects: [
${r.objects.map(obj).join("\n")}
      ],
      onKey: {
${onKey}
      },
${roles}
    },`;
  };

  return `// _shared/cases/${cf.id || "untitled"}.ts — 卦案：${cf.title}
//
// 由 dev/form.html 產出。設計師寫死的世界：AI 只能從這裡選素材演繹，
// 不得增加線索、NPC、區域，不得改寫 truth，不得因卦象不同而改變真相。

import type { CaseFile } from "../case-schema.ts";

export const ${(cf.id || "CASE").toUpperCase().replace(/[^A-Z0-9_]/g, "_")}: CaseFile = {
  id: ${q(cf.id)},
  title: ${q(cf.title)},
  version: ${cf.version || 1},
  question: ${q(cf.question)},
  useQin: ${q(cf.useQin)},
  entryHour: ${cf.entryHour == null ? "null" : cf.entryHour},
  voidPolicy: ${q(cf.voidPolicy)},

  truth: ${q(cf.truth)},

  regions: [
${cf.regions.map(region).join("\n")}
  ],

  clues: [
${cf.clues.map((c) => `    { id: ${q(c.id)}, name: ${q(c.name)}, region: ${c.region}, kind: ${q(c.kind)}` +
    (c.requires?.length ? `, requires: [${c.requires.map(q).join(", ")}]` : "") +
    `,\n      text: ${q(c.text)} },`).join("\n")}
  ],

  npcs: [
${cf.npcs.map((n) => `    {
      id: ${q(n.id)}, name: ${q(n.name)}, region: ${n.region},
      voice: ${q(n.voice)},
      says: [
${(n.says ?? []).map((l) => "        { " +
    (l.needs?.length ? `needs: [${l.needs.map(q).join(", ")}], ` : "") +
    (l.clue ? `clue: ${q(l.clue)}, ` : "") +
    `text: ${q(l.text)} },`).join("\n")}
      ],
    },`).join("\n")}
  ],

  companions: [
${cf.companions.map((c) => `    { id: ${q(c.id)}, regions: [${c.regions.join(", ")}], ` +
    `clues: [${c.clues.map(q).join(", ")}],\n      trigger: ${q(c.trigger)} },`).join("\n")}
  ],
};
`;
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ═══════════════ 繪製 ═══════════════ */

function renderSide() {
  const rep = coverage();
  const el = document.getElementById("side");
  if (el) el.innerHTML = sidePanel(rep);
  paintStatus();

  // 表單本身不重繪（會踢掉游標），但「下一個該填哪個」的標記要跟著右盤走，
  // 否則剛填完的那格還掛著「← 下一個」，兩邊講的話不一樣。
  const next = rep.needs.find((n) => !n.filled);
  for (const el2 of Array.from(document.querySelectorAll<HTMLElement>(".slot"))) {
    const path = el2.querySelector("textarea")?.dataset.path ?? "";
    const m = /^regions\.(\d+)\.onKey\.(.+)$/.exec(path);
    const isNext = Boolean(next && m && cf.regions[Number(m[1])]?.pos === next.pos && m[2] === next.access);
    el2.classList.toggle("next", isNext);
    el2.classList.toggle("done", Boolean(el2.querySelector("textarea")?.value.trim()));
    const tag = el2.querySelector<HTMLElement>(".slot-p");
    if (tag) {
      const base = tag.textContent?.replace(" ← 下一個", "") ?? "";
      tag.textContent = isNext ? base + " ← 下一個" : base;
    }
  }
}

function render() {
  if (mode === "play") { renderPlay(); return; }
  const rep = coverage();
  app.innerHTML = `
  <div class="top">
    <h1>案件填表</h1>
    <button class="tb" data-act="load-huangcun">載入荒村借宿</button>
    <button class="tb" data-act="blank">空白新案</button>
    <button class="tb" data-act="import">匯入 JSON</button>
    <button class="tb" data-act="play">試玩</button>
    <button class="tb" data-act="prompt">生成初稿指令</button>
    ${CAP.artifact ? `<button class="tb on" data-act="cloud-save">存到雲端</button>` : ""}
    <span class="sp"></span>
    <span class="saved" id="cloudMsg">${esc(cloudMsg)}</span>
    <span class="saved" id="savedAt"></span>
    <button class="tb" data-act="export-json">匯出 JSON</button>
    <button class="tb" data-act="export-ts">匯出 ${CAP.downloads ? ".ts.txt" : ".ts"}</button>
  </div>
  <div class="app">
    <div class="form">
      ${secCase()}
      ${secRegions(rep)}
      ${secClues()}
      ${secNpcs()}
      ${secCompanions()}
    </div>
    <div class="side" id="side">${sidePanel(rep)}</div>
  </div>`;
  paintStatus();
}



/* ═══════════════ 生成初稿指令 ═══════════════ */

// 這支工具裡沒有模型，也不該有——填表是本機／沙箱環境，塞 API key 進去等於把金鑰
// 發佈出去。所以這顆按鈕產的是「指令稿」：把事件全貌、已定的六區、以及線索與物件
// 該長什麼樣的規格，一次寫成一份完整的 prompt，你貼給 Claude，拿回 JSON 再匯入。
// 中間多一手，換到的是你逐條看過才進檔——AI 生的線索本來就該過人眼。
function draftPrompt(): string {
  const regions = cf.regions
    .map((r) => `- 第 ${r.pos} 爻「${r.name || "（未命名）"}」　取象：${r.image}\n  場景：${r.desc || "（未寫）"}`)
    .join("\n");
  const haveClues = cf.clues.length
    ? cf.clues.map((c) => `- ${c.id}（${c.kind}）${c.name}：${c.text}`).join("\n")
    : "（目前沒有）";
  const haveObjects = cf.regions.flatMap((r) =>
    r.objects.map((o) => `- ${r.pos} 區 ${o.id} ${o.name}${o.clue ? ` → ${o.clue}` : ""}`)).join("\n") || "（目前沒有）";

  return `# 卦案線索初稿：《${cf.title || "未命名"}》

我在寫一個六爻卦案。以下是這個案子的設定，請依規格產出**線索（clues）與可調查物件（objects）**的初稿 JSON。

## 事件全貌（只給你看，玩家看不到）

${cf.brief?.trim() || "⚠ 這一欄還沒寫。沒有事件全貌就編不出彼此對得上的線索，請先回去補。"}

## 結案時給玩家看的那段（口吻參考）

${cf.truth || "（未寫）"}

## 進案問句與用神

問句：${cf.question || "（未寫）"}　用神：${cf.useQin}

## 六區（爻位固定，不能增減）

${regions}

## 目前已有的線索

${haveClues}

## 目前已有的物件

${haveObjects}

## 規格

線索 clue：
- \`id\`：\`c_\` 開頭的英數小寫，全案唯一
- \`name\`：四到八字的短名，玩家在「手上／已看出」清單裡看到的就是這個
- \`region\`：1..6，線索所在的爻位區
- \`kind\`：\`knowledge\`（你知道了什麼）或 \`item\`（你手上有什麼，可攜帶、可撬、可出示）
- \`text\`：一到兩句，寫「這條線索告訴玩家什麼事實」，不要寫玩家的反應或心情
- \`requires\`（可省）：前置線索 id 陣列。**不得成環**——A 需要 B、B 需要 A 就是死鎖，玩家永遠解不開

物件 object（掛在某一區底下）：
- \`id\`：\`o_\` 開頭
- \`name\`：兩到四字，玩家在「此處」看到的按鈕字樣
- \`desc\`：一句，調查它會看到什麼
- \`clue\`（可省）：調查後取得的線索 id
- \`needsItem\`（可省）：要先持有的道具 id。**只能指向 kind 為 item 的線索**——知識撬不開門

硬性規則：
1. 每一條線索都必須至少有一個物件指向它（\`clue\` 欄），否則玩家沒有取得途徑，是孤兒線索
2. 六區都要有東西可查，不要讓某一區空著
3. 所有線索合起來要能推到事件全貌的核心，但**單獨任何一條都不足以推出結論**
4. 線索之間要能互相印證或互相矛盾，矛盾是好的——那是玩家判斷的依據
5. 不要寫玩家的動作與情緒（不要出現「你感到不安」「你決定」），只寫客觀所見

## 輸出

只輸出一段 JSON，格式如下，不要其他說明：

\`\`\`json
{
  "clues": [ { "id": "...", "name": "...", "region": 1, "kind": "knowledge", "text": "..." } ],
  "objectsByRegion": { "1": [ { "id": "...", "name": "...", "desc": "...", "clue": "..." } ] }
}
\`\`\`
`;
}

/* ═══════════════ 試玩 ═══════════════ */

// 直接拿當下的草稿開跑，不必匯出再匯入——改一句、試一次，才追得動手感。
function renderPlay() {
  const errs = validateCase(cf);
  app.innerHTML = `
  <div class="top">
    <h1>試玩　<span class="dim" style="font-size:13px">${esc(cf.title || "未命名")}</span></h1>
    <button class="tb" data-act="back">回填表</button>
    <span class="sp"></span>
    <span class="saved">起卦是真隨機的：同一份案件，每次進來的代價都不一樣</span>
  </div>
  <div id="playRoot"></div>`;

  const root = document.getElementById("playRoot")!;
  if (errs.length) {
    // 結構壞掉還硬跑，會在玩到一半才炸，且看不出是資料問題還是引擎問題
    root.innerHTML = `<div class="wrap" style="max-width:760px;margin:0 auto;padding:32px 24px">
      <p class="err">案件檔有 ${errs.length} 項結構錯誤，先修好才試得動：</p>
      ${errs.map((e) => `<p class="err">・${esc(e)}</p>`).join("")}
    </div>`;
    return;
  }
  mountPlay(root, cf);
}

/* ═══════════════ 事件 ═══════════════ */

// 逗號分隔的欄位：表單存字串，模型存陣列
const LIST_PATHS = /(\.requires|\.needs|companions\.\d+\.(regions|clues))$/;
const NUM_LIST = /companions\.\d+\.regions$/;

function readControl(path: string, raw: string): unknown {
  if (path === "entryHour") return raw === "依玩家當下" ? null : Number(raw);
  if (/^clues\.\d+\.region$|^npcs\.\d+\.region$/.test(path)) return Number(raw);
  // NPC 台詞的 clue 是文字輸入（不是下拉），留空就是「這句不給線索」
  if (/\.clue$/.test(path)) return (!raw.trim() || raw === "（不給線索）") ? undefined : raw;
  if (/\.needsItem$/.test(path)) return raw === "（不需道具）" ? undefined : raw;
  if (LIST_PATHS.test(path)) {
    const parts = raw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    return NUM_LIST.test(path) ? parts.map(Number).filter((n) => !Number.isNaN(n)) : parts;
  }
  return raw;
}

// 打字時只重畫右盤；整份重繪會讓游標跳掉、選字中斷
let tick = 0;
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const path = t.dataset.path;
  if (!path) return;
  setPath(cf, path, readControl(path, t.value));
  save();
  clearTimeout(tick);
  tick = setTimeout(renderSide, 180) as unknown as number;
});

// select 改動可能牽動結構（用神／時辰改了機率整份要重算）
app.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (!t.dataset.path) return;
  if (t.dataset.path === "useQin" || t.dataset.path === "entryHour") render();
});

app.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("button, .reg-h") as HTMLElement | null;
  if (!t) return;

  const toggle = t.dataset.toggle;
  if (toggle) { openRegion = openRegion === Number(toggle) ? -1 : Number(toggle); render(); return; }

  const jump = t.dataset.jump;
  if (jump) {
    openRegion = Number(jump);
    render();
    document.querySelector(`.reg[data-open="1"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const add = t.dataset.add;
  if (add === "object") {
    cf.regions[Number(t.dataset.ri)].objects.push({ id: "", name: "", desc: "" });
    save(); render(); return;
  }
  if (add === "clue") {
    cf.clues.push({ id: "", name: "", region: 1, text: "", kind: "knowledge" } as ClueFile);
    save(); render(); return;
  }
  if (add === "say") {
    const npc = cf.npcs[Number(t.dataset.i)];
    (npc.says ??= []).push({ text: "" });
    save(); render(); return;
  }
  if (add === "npc") {
    cf.npcs.push({ id: "", name: "", region: 1, voice: "", says: [{ text: "" }] } as NpcFile);
    save(); render(); return;
  }
  if (add === "companion") {
    cf.companions.push({ id: t.dataset.cid!, regions: [], clues: [], trigger: "" } as CompanionFile);
    save(); render(); return;
  }

  const del = t.dataset.del;
  if (del === "object") {
    cf.regions[Number(t.dataset.ri)].objects.splice(Number(t.dataset.i), 1);
    save(); render(); return;
  }
  if (del === "clue") { cf.clues.splice(Number(t.dataset.i), 1); save(); render(); return; }
  if (del === "npc") { cf.npcs.splice(Number(t.dataset.i), 1); save(); render(); return; }
  if (del === "say") { cf.npcs[Number(t.dataset.i)].says.splice(Number(t.dataset.j), 1); save(); render(); return; }
  if (del === "companion") { cf.companions.splice(Number(t.dataset.i), 1); save(); render(); return; }

  const act = t.dataset.act;
  if (act === "load-huangcun") { cf = structuredClone(HUANGCUN) as CaseFile; probCache = null; save(); render(); return; }
  if (act === "blank") {
    if (!confirm("清成空白新案？目前草稿會被覆蓋（先匯出比較保險）。")) return;
    cf = blankCase(); probCache = null; save(); render(); return;
  }
  if (act === "play") { mode = "play"; render(); return; }
  if (act === "back") { mode = "form"; render(); return; }
  if (act === "prompt") { void offerFile(`${cf.id || "case"}-初稿指令`, "md", draftPrompt()); return; }
  if (act === "cloud-save") { void cloudSave(); return; }
  if (act === "export-json") { void offerFile(cf.id || "case", "json", JSON.stringify(cf, null, 2)); return; }
  if (act === "export-ts") { void offerFile(cf.id || "case", "ts", toTS()); return; }
  if (act === "import") {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        cf = JSON.parse(await f.text()) as CaseFile;
        probCache = null; save(); render();
      } catch (err) {
        alert("這個檔案讀不進來：" + (err as Error).message);
      }
    };
    inp.click();
    return;
  }
});

render();
void initCaps();
