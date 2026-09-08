// dev/gua-eval.mts — 解卦引擎離線盲測：同一張盤面，兩個模型各解一次，並排讓人評。
//
// 【為什麼要這一支】
//
// 應期回評永遠分辨不出小差距。用你目前的量算一次就知道：要在 95% 信心下分辨
// 10 個百分點（50% vs 40%）的差距，每一組需要約 385 筆回評；20 個百分點也要 94 筆。
// 而全站四個月累積的回評總共 133 筆。等它長到 385，是好幾年的事。
//
// 更糟的是回評本身有偏差：願意回來點「準不準」的人，本來就偏向有感覺的那一批；
// 而且 verdict 記的是「整段批文準不準」，用戶按下去的時候想的可能是「事情順不順」。
// 這些偏差不會隨樣本變大而消失。
//
// 所以決定主力模型的正確工具不是等回評，是**拿已知結果的舊卦盤重跑一次**：
//   ・沒有回報偏差——每一張都跑，不是只有想回報的人那幾張
//   ・你讀得出回評看不出的硬錯誤（用神取錯、應期亂給、把靜爻講成動爻）
//   ・二十張跑完是一個下午，不是半年
//   ・零風險：不碰線上、不影響任何用戶、不寫任何一張表
//
// 【這支順便量了線上完全沒記錄的三件事】
//   1. 每次呼叫的實際延遲（p50 / p95）——ai_usage 沒有這一欄，而 KIMI 大陸版的
//      跨境延遲正是現在最該量的東西
//   2. 備援觸發率。callInterpret 主模型掛掉會換家重打，回傳的 model 是真正出手的
//      那一個。要求 kimi 卻拿回 claude ＝ 這一次備援了。線上這件事只寫在 console，
//      沒有進資料庫，所以「KIMI 期間有多少卦其實是 Claude 解的」從來沒人知道
//   3. 每次呼叫的真實 token 與成本（含快取寫/讀分欄）
//
// 【四個為了「比的是模型、不是別的」而刻意做的決定】
//
//   一、盤面直接取 casts.chart，不重新排盤。重排等於換了一張卦，比出來的是運氣。
//   二、用神沿用當時鎖定的 yong_qin / yong_via_shi。不鎖的話兩個模型可能各取各的
//       用神，那比的是「取用神」不是「解卦」——而用神取法在 rules.ts 裡是共用的。
//   三、角色聲線用當時那張卦的 persona_prompt。換角色會換掉整個語氣，讀起來像換了
//       一個人在解卦，你會把文風差異誤讀成能力差異。
//   四、A/B 每一張卦獨立隨機對調，答案鍵另存一個檔。固定順序讀個三張就被看穿了，
//       而一旦知道哪份是誰的，後面每一張的判斷都會被那個知識污染。
//
// 跑法（先設好三把金鑰，見下）：
//   node dev/gua-eval.mts                          # 抽 20 張已回評的卦，比 sonnet vs kimi
//   node dev/gua-eval.mts -n 30
//   node dev/gua-eval.mts --miss                   # 只抽「未應」的卦（爭議最大、最有料）
//   node dev/gua-eval.mts --models claude-sonnet-4-6,kimi-k2.6,claude-haiku-4-5-20251001
//   node dev/gua-eval.mts --cases last             # 重跑最近那一批（改了 rules 之後對照用）
//   node dev/gua-eval.mts --cases dev/.eval/fixture-2026-09-08T05-26-37.json   # 指定某一批
//
// 需要的環境變數：
//   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # 抽卦盤用（同 dev/casts.ps1）
//   $env:ANTHROPIC_API_KEY     = "sk-ant-..."
//   $env:KIMI_API_KEY          = "sk-..."    # 要跟 KIMI_API_BASE 同區，金鑰跨區不通用
//   $env:KIMI_API_BASE         = "https://api.moonshot.ai/v1"   # 選填，不設走國際版
//
// ⚠ 這支會真的呼叫 API、真的花錢。20 張 × 2 個模型 ＝ 40 次解卦，大約 NT$30。
//   超過 100 次呼叫會要求加 --yes，免得手滑打成 -n 500。
//
// 產出（全部寫在 dev/.eval/，已進 .gitignore——裡面有真實用戶的問題與評語，不進 repo）：
//   fixture-<時間>.json   抽出來的卦盤，之後要重跑同一批就指 --cases 這個檔
//   report-<時間>.md      盲測讀本：問題、盤面、A/B 兩份批文、後來實際發生什麼
//   key-<時間>.json       答案鍵＋每個模型的延遲、token、成本、備援次數

import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ═══ 共用小工具 ═══ */

/** services.ts 在載入時就讀 Deno.env，node 沒有這個全域。
 *  billing-test.mts 擺的替身一律回 undefined（它要的是預設值）；這裡不行——
 *  這支要真的打 API，金鑰必須讀得到，所以轉接到 process.env。 */
function shimDeno() {
  (globalThis as Record<string, unknown>).Deno ??= {
    env: { get: (k: string) => process.env[k] },
  };
}

/** Management API 的回應形狀不保證：一般是「每列一個物件」，也遇過整包變成
 *  「單一物件、每個欄位一條等長陣列」的欄式。欄式不轉回列不會報錯，只會讓每一列
 *  都拿到同一份資料——那比報錯危險。與 dev/engine-ab.ps1 的 ConvertTo-Rows 同一套判定。 */
function toRows<T = Record<string, unknown>>(data: unknown): T[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data as T[];
  const obj = data as Record<string, unknown>;
  for (const k of ["result", "data", "rows"]) {
    if (obj[k] != null) return toRows<T>(obj[k]);
  }
  const keys = Object.keys(obj);
  if (keys.length && keys.every((k) => Array.isArray(obj[k]))) {
    const n = (obj[keys[0]] as unknown[]).length;
    if (keys.every((k) => (obj[k] as unknown[]).length === n)) {
      return Array.from({ length: n }, (_, i) => {
        const row: Record<string, unknown> = {};
        for (const k of keys) row[k] = (obj[k] as unknown[])[i];
        return row as T;
      });
    }
  }
  return [obj as T];
}

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "ajogafvzlhqwlxwkfcpn";

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("沒有 SUPABASE_ACCESS_TOKEN。設定方式見檔頭。");
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL 失敗 ${res.status}：${text.slice(0, 300)}`);
  return toRows<T>(JSON.parse(text));
}

type Fixture = {
  id: string;
  question: string;
  category: string | null;
  gua_ben: string;
  created_at: string;
  chart: Record<string, unknown>;
  yong_qin: string | null;
  yong_via_shi: boolean | null;
  persona: string;
  character_name: string;
  /** 上線當時實際用的模型與用戶回評——只進答案鍵，不進盲測讀本 */
  orig_model: string | null;
  verdict: number;
  note: string | null;
};

type Result = {
  id: string;
  ok: boolean;
  reading: string;
  due: string | null;
  digest: string | null;
  /** 真正出手的模型。與要求的不同 ＝ 這一次備援了 */
  actual_model: string;
  ms: number;
  usage: { in: number; out: number; cacheWrite: number; cacheRead: number };
  stop_reason: string | null;
  error?: string;
};

/* ═══ worker：一個行程只跑一個模型 ═══
   為什麼要開子行程，而不是在同一支裡換模型跑兩輪：services.ts 的
   INTERPRET_FORCE_MODEL 是模組載入時就抓進 const 的，同一個行程裡再改環境變數
   對它沒有作用。ESM 的 module cache 也不會因為換環境變數就重新求值。
   開子行程是唯一能保證「這一輪真的用了這個模型」而且完全走生產程式碼的做法。 */
async function runWorker(model: string, fixturePath: string, outPath: string, keepGoing: boolean) {
  process.env.INTERPRET_FORCE_MODEL = model;
  // 盲測一定要關備援。開著的話，要求 kimi 而 kimi 掛掉時會拿回 claude 的批文，
  // 並排比較的就變成同一個模型自己跟自己比——而且讀本上看不出來。
  // （順帶：備援開著時丟出來的是「備援的錯誤」，主模型的真正錯誤只寫進 console。
  //   上一輪的報告因此在 claude 那欄印出 kimi 的 401，看起來像叫錯了模型。）
  process.env.INTERPRET_FALLBACK_MODEL = "off";
  shimDeno();

  const { callInterpret } = await import("../supabase/functions/_shared/services.ts");
  const { chartTextFull } = await import("../supabase/functions/_shared/dongyao.ts");
  const { pickUsePos } = await import("../supabase/functions/_shared/core.ts");

  const cases: Fixture[] = JSON.parse(readFileSync(fixturePath, "utf8"));
  const out: Result[] = [];

  for (const [i, c] of cases.entries()) {
    // deno-lint-ignore no-explicit-any
    const chart = c.chart as any;
    const ctext = chartTextFull(chart, c.question);
    const yong = c.yong_qin
      ? { yong: { qin: c.yong_qin, viaShi: c.yong_via_shi ?? false, pos: pickUsePos(chart, c.yong_qin, c.yong_via_shi ?? false) } }
      : {};
    const t0 = performance.now();
    try {
      const ai = await callInterpret(c.persona, ctext, yong);
      const ms = Math.round(performance.now() - t0);
      out.push({
        id: c.id, ok: true, reading: ai.reading ?? "", due: ai.due ?? null, digest: ai.digest ?? null,
        actual_model: ai.model, ms,
        usage: { in: ai.usage.in, out: ai.usage.out, cacheWrite: ai.usage.cacheWrite ?? 0, cacheRead: ai.usage.cacheRead ?? 0 },
        stop_reason: ai.stopReason ?? null,
      });
      const flag = ai.model === model ? "" : `  ⚠ 備援 → ${ai.model}`;
      process.stderr.write(`    [${model}] ${i + 1}/${cases.length}  ${ms}ms${flag}\n`);
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      out.push({
        id: c.id, ok: false, reading: "", due: null, digest: null, actual_model: model, ms,
        usage: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 }, stop_reason: null,
        error: e instanceof Error ? e.message : String(e),
      });
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`    [${model}] ${i + 1}/${cases.length}  ✗ ${ms}ms ${msg}\n`);
      // 第一張就掛＝幾乎一定是設定問題（金鑰、區域、模型名），不是運氣。
      // 這時候把剩下 19 張跑完只會燒錢，還產出一份整本都是錯誤訊息的讀本——
      // 上一輪就是這樣浪費了 40 次呼叫。停下來，把診斷講清楚。
      if (i === 0 && !keepGoing) {
        writeFileSync(outPath, JSON.stringify(out), "utf8");
        process.stderr.write(`\n  ✗ [${model}] 第一張就失敗，停止這一輪（要硬跑完加 --keep-going）\n`);
        process.stderr.write(`    ${diagnose(model, msg)}\n`);
        process.exit(2);
      }
    }
  }
  writeFileSync(outPath, JSON.stringify(out), "utf8");
}

/** 把供應商的錯誤翻成「你該去改哪個環境變數」 */
function diagnose(model: string, msg: string): string {
  const isKimi = /^(kimi|moonshot)/i.test(model);
  if (/401|authentication|invalid.*key|unauthorized/i.test(msg)) {
    if (isKimi) {
      const base = process.env.KIMI_API_BASE ?? "https://api.moonshot.ai/v1（預設，國際版）";
      return `KIMI 認證失敗。目前 KIMI_API_BASE=${base}\n` +
        `    金鑰跨區不通用：大陸版 platform.kimi.com 的金鑰要配 https://api.moonshot.cn/v1，\n` +
        `    國際版 platform.kimi.ai 的金鑰要配 https://api.moonshot.ai/v1。兩者對調就是這個 401。`;
    }
    return `Anthropic 認證失敗。檢查 ANTHROPIC_API_KEY 有沒有設、是不是 sk-ant- 開頭的完整字串。`;
  }
  if (/404|not_found|model/i.test(msg)) return `型號名可能不對：「${model}」在該供應商那邊查無此模型。`;
  if (/429|rate/i.test(msg)) return `被限流了。等一下再跑，或減少 -n。`;
  if (/timeout|abort/i.test(msg)) return `逾時。KIMI 大陸版跨境本來就慢，可調 KIMI_TIMEOUT_MS。`;
  return `原始錯誤如上。`;
}

/* ═══ 成本 ═══ */

type Price = { model_prefix: string; usd_in: number; usd_cache_write: number; usd_cache_read: number; usd_out: number };

function priceOf(model: string, prices: Price[], kimi: { in: number; out: number; cacheRead: number }): Price | null {
  if (/^(kimi|moonshot)/i.test(model)) {
    // KIMI 不在 model_prices 裡（0043 刻意留白：「填一個猜的數字比空著更糟」）。
    // 由參數帶入，報表會把用到的數字印出來。快取寫入沒有優惠價，照輸入價算。
    return { model_prefix: model, usd_in: kimi.in, usd_cache_write: kimi.in, usd_cache_read: kimi.cacheRead, usd_out: kimi.out };
  }
  const hit = prices
    .filter((p) => model.startsWith(p.model_prefix))
    .sort((a, b) => b.model_prefix.length - a.model_prefix.length)[0];
  return hit ?? null;
}

function usdOf(r: Result, prices: Price[], kimi: { in: number; out: number; cacheRead: number }): number | null {
  const p = priceOf(r.actual_model, prices, kimi);
  if (!p) return null;   // 認不出單價就回 null，不假裝它免費
  return (
    r.usage.in / 1e6 * p.usd_in +
    r.usage.cacheWrite / 1e6 * p.usd_cache_write +
    r.usage.cacheRead / 1e6 * p.usd_cache_read +
    r.usage.out / 1e6 * p.usd_out
  );
}

/** 最近秩（nearest-rank）：ceil(q×n) - 1。用 floor(q×n) 的話，兩個樣本的 p50
 *  會取到較大的那一個——延遲這種右尾很長的東西，那個差別會讓 p50 說謊。 */
const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/* ═══ 主流程 ═══ */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt?: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  const has = (name: string) => argv.includes(name);

  const n = Number(flag("-n", flag("--n", "20")));
  const models = (flag("--models", "claude-sonnet-4-6,kimi-k2.6") as string).split(",").map((s) => s.trim()).filter(Boolean);
  const kimi = {
    in: Number(flag("--kimi-in", "0.95")),
    out: Number(flag("--kimi-out", "4.00")),
    cacheRead: Number(flag("--kimi-cache-read", "0.15")),
  };
  const twd = Number(flag("--twd", "32"));
  const missOnly = has("--miss");
  const casesPath = flag("--cases");

  const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".eval");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // ── 1. 取卦盤
  let cases: Fixture[];
  if (casesPath) {
    // --cases last：挑 dev/.eval 裡最新的 fixture。檔名帶時間戳，手打很容易錯一個字元，
    // 而「重跑上一批」正是這支最常做的事（改完 rules.ts 前後對照）。
    let cp = casesPath;
    if (cp === "last" || cp === "latest") {
      const found = existsSync(outDir)
        ? readdirSync(outDir).filter((f) => f.startsWith("fixture-") && f.endsWith(".json"))
            .map((f) => path.join(outDir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
        : [];
      if (!found.length) { console.log(`${outDir} 裡找不到任何 fixture-*.json。先不帶 --cases 跑一次產生樣本。`); return; }
      cp = found[0];
    }
    cases = JSON.parse(readFileSync(cp, "utf8"));
    console.log(`重跑既有樣本：${cp}（${cases.length} 張）`);
  } else {
    console.log(`抽樣中……（已回評、排除日運${missOnly ? "、只取未應" : ""}）`);
    const where = missOnly ? "f.verdict = 3" : "f.verdict in (1,2,3)";
    // random() 排序：不挑順手的樣本。要固定樣本就用 --cases 重跑同一個 fixture。
    cases = await sql<Fixture>(
      "select c.id::text as id, c.question, c.category, c.gua_ben, " +
      "to_char(c.created_at at time zone 'Asia/Taipei','YYYY-MM-DD') as created_at, " +
      "c.chart, c.yong_qin, c.yong_via_shi, " +
      "ch.persona_prompt as persona, ch.name as character_name, " +
      "c.model as orig_model, f.verdict, f.note " +
      "from casts c " +
      "join feedback f on f.cast_id = c.id " +
      "join characters ch on ch.id = c.character_id " +
      `where ${where} and coalesce(c.category,'') <> '日運' ` +
      "and c.chart is not null and coalesce(c.question,'') <> '' " +
      `order by random() limit ${n};`,
    );
  }
  if (!cases.length) { console.log("沒有符合條件的卦。"); return; }

  const calls = cases.length * models.length;
  console.log(`樣本 ${cases.length} 張 × 模型 ${models.length} 個 ＝ ${calls} 次解卦呼叫`);
  if (calls > 100 && !has("--yes")) {
    console.log(`超過 100 次呼叫。確定的話加 --yes 再跑一次。`);
    return;
  }

  const fixturePath = path.join(outDir, `fixture-${stamp}.json`);
  writeFileSync(fixturePath, JSON.stringify(cases, null, 1), "utf8");

  // ── 2. 每個模型開一個子行程跑完整批
  const self = fileURLToPath(import.meta.url);
  const results: Record<string, Result[]> = {};
  for (const m of models) {
    console.log(`\n── ${m} ──`);
    const rp = path.join(outDir, `raw-${stamp}-${m.replace(/[^a-z0-9.-]/gi, "_")}.json`);
    await new Promise<void>((resolve, reject) => {
      const wargs = [self, "--worker", m, fixturePath, rp];
      if (has("--keep-going")) wargs.push("--keep-going");
      const ch = spawn(process.execPath, wargs, { stdio: ["ignore", "inherit", "inherit"] });
      ch.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${m} 沒有跑完（子行程結束碼 ${code}）。上面那段診斷講了原因；修好再跑一次，樣本用 --cases ${fixturePath} 指同一批。`))));
      ch.on("error", reject);
    });
    results[m] = JSON.parse(readFileSync(rp, "utf8"));
  }

  // ── 3. 單價（Claude 讀資料庫、KIMI 走參數）
  let prices: Price[] = [];
  try {
    prices = (await sql<Price>("select model_prefix, usd_in, usd_cache_write, usd_cache_read, usd_out from model_prices;"))
      .map((p) => ({ ...p, usd_in: Number(p.usd_in), usd_cache_write: Number(p.usd_cache_write), usd_cache_read: Number(p.usd_cache_read), usd_out: Number(p.usd_out) }));
  } catch { console.log("（讀不到 model_prices，成本欄會留空）"); }

  // ── 4. 盲測讀本：A/B 每張獨立隨機對調
  const V: Record<number, string> = { 1: "應驗", 2: "部分應驗", 3: "未應" };
  // 盲測的前提是讀的人看不出哪份是誰的。批文正常不會自報家門，但只要出現一次
  // （角色設定被問破、模型自我介紹），那一張之後的判斷就全被污染了——而你不會
  // 知道是從哪一張開始的。成本只是一個 replace，就別賭。
  const BRANDS = /claude|anthropic|sonnet|haiku|opus|kimi|moonshot|月之暗面|gpt|openai|gemini/gi;
  const blind = (t: string) => t.replace(BRANDS, "▮▮");
  const key: Record<string, unknown>[] = [];
  // 只有「每個模型都成功」的卦才進讀本。缺一份的並排沒有意義，而把錯誤訊息
  // 排進讀本會讓人一頁一頁翻過二十段一模一樣的 401——上一輪就是這樣。
  const usable = cases.filter((c) => models.every((m) => results[m].find((x) => x.id === c.id)?.ok));
  const broken = cases.filter((c) => !usable.includes(c));

  const md: string[] = [
    `# 解卦盲測讀本　${stamp}`,
    "",
    `共 ${usable.length} 張卦，每張兩份批文。**A / B 每一張都獨立隨機對調過**，讀完之前不要開 key 檔。`,
    ...(broken.length ? [`（另有 ${broken.length} 張因為呼叫失敗沒有進讀本，列在最後。）`] : []),
    "",
    "讀法：先看問題與盤面，再讀 A、B，判斷哪一份「更準、更有用」。建議每張只記一個字：A、B 或 =。",
    "",
    `模型：${models.join("　vs　")}（順序已打散）`,
    "",
    "---",
    "",
  ];

  usable.forEach((c, idx) => {
    const pair = models.map((m) => ({ m, r: results[m].find((x) => x.id === c.id) }));
    // Fisher-Yates 洗這一張的 A/B（模型多於兩個時同樣適用）
    for (let i = pair.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pair[i], pair[j]] = [pair[j], pair[i]];
    }
    const labels = "ABCDEFG".split("");

    md.push(`## ${idx + 1}. ${c.category ?? "（無分類）"}　《${c.gua_ben}》　${c.created_at}`);
    md.push("");
    md.push(`**問**：${c.question}`);
    md.push(`**解卦人**：${c.character_name}　**用神**：${c.yong_qin ?? "（未鎖定）"}${c.yong_via_shi ? "（世爻）" : ""}`);
    md.push("");
    pair.forEach((p, i) => {
      md.push(`### ${labels[i]}`);
      md.push("");
      md.push(blind(p.r!.reading) || "（空批文）");
      if (p.r?.due) md.push(`\n*應期：${p.r.due}*`);
      // 備援換家：這一份其實不是掛名的那個模型寫的。不標出來的話，讀本上會有一組
      // 「同一個模型自己跟自己比」而看不出來。批文照留，但要說清楚它不算數。
      if (p.r && p.r.actual_model !== p.m) md.push(`\n> ⚠ 這一份是備援模型寫的，不列入比較。`);
      md.push("");
    });
    md.push(`**後來實際發生**：${c.note ?? "（用戶沒留評語，只點了「" + (V[c.verdict] ?? "?") + "」）"}`);
    md.push("");
    md.push("---");
    md.push("");

    key.push({
      no: idx + 1,
      cast_id: c.id,
      question: c.question,
      對照: Object.fromEntries(pair.map((p, i) => [labels[i], p.m])),
      實際出手模型: Object.fromEntries(pair.map((p, i) => [labels[i], p.r?.actual_model ?? "?"])),
      延遲ms: Object.fromEntries(pair.map((p, i) => [labels[i], p.r?.ms ?? null])),
      上線當時: { model: c.orig_model, verdict: V[c.verdict] ?? c.verdict, note: c.note },
    });
  });

  if (broken.length) {
    md.push("## 未納入的卦（呼叫失敗）");
    md.push("");
    md.push("錯誤訊息原樣保留——它是拿來查設定的，不是給人盲讀的。");
    md.push("");
    for (const c of broken) {
      md.push(`- **${c.question}**`);
      for (const m of models) {
        const r = results[m].find((x) => x.id === c.id);
        if (r && !r.ok) md.push(`    - \`${m}\`：${r.error}`);
      }
    }
    md.push("");
  }

  const reportPath = path.join(outDir, `report-${stamp}.md`);
  writeFileSync(reportPath, md.join("\n"), "utf8");

  // ── 5. 統計：延遲、備援、成本
  console.log("\n═══ 摘要 ═══");
  const summary: Record<string, unknown>[] = [];
  for (const m of models) {
    const rs = results[m];
    const okRs = rs.filter((r) => r.ok);
    const lat = okRs.map((r) => r.ms);
    const fell = okRs.filter((r) => r.actual_model !== m);
    const usds = okRs.map((r) => usdOf(r, prices, kimi));
    const priced = usds.filter((u): u is number => u != null);
    const row = {
      模型: m,
      成功: `${okRs.length}/${rs.length}`,
      備援次數: fell.length,
      "延遲p50": `${(pct(lat, 0.5) / 1000).toFixed(1)}s`,
      "延遲p95": `${(pct(lat, 0.95) / 1000).toFixed(1)}s`,
      最慢: `${(Math.max(0, ...lat) / 1000).toFixed(1)}s`,
      平均字數: okRs.length ? Math.round(okRs.reduce((s, r) => s + r.reading.length, 0) / okRs.length) : 0,
      給應期: okRs.filter((r) => r.due).length,
      台幣合計: priced.length ? (priced.reduce((a, b) => a + b, 0) * twd).toFixed(2) : "—",
      每卦台幣: priced.length ? (priced.reduce((a, b) => a + b, 0) * twd / priced.length).toFixed(3) : "—",
      未計價: usds.length - priced.length,
    };
    summary.push(row);
  }
  console.table(summary);

  for (const m of models) {
    const fell = results[m].filter((r) => r.ok && r.actual_model !== m);
    if (fell.length) {
      console.log(`⚠ ${m} 有 ${fell.length} 次備援換家（實際出手：${[...new Set(fell.map((f) => f.actual_model))].join("、")}）。`);
      console.log(`  線上發生同樣的事時，casts.model 記的是備援後那一個——所以「${m} 期間的卦」有一部分其實不是它解的。`);
    }
  }

  const keyPath = path.join(outDir, `key-${stamp}.json`);
  writeFileSync(keyPath, JSON.stringify({ models, kimi_price: kimi, usd_twd: twd, summary, cases: key }, null, 1), "utf8");

  console.log(`\n讀本　${reportPath}`);
  console.log(`答案　${keyPath}　←　讀完再開`);
  console.log(`樣本　${fixturePath}　←　改了 rules.ts 之後用 --cases 指它，就是同一批卦的前後對照`);
}

/* ═══ 進入點 ═══ */
const a = process.argv.slice(2);
if (a[0] === "--worker") {
  await runWorker(a[1], a[2], a[3], a.includes("--keep-going"));
} else {
  // 設定錯誤是這支最常見的失敗，而它已經在上面印過一段人看得懂的診斷了。
  // 再吐一份 node 的堆疊只會把那段診斷推到螢幕外。
  try {
    await main();
  } catch (e) {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
