// dev/model-ab.mts — 同一張盤、同一句問，換模型並排解一次，比讀盤正確性與成本。
//
// 為什麼不是 engine-ab.ps1：那支看的是線上已回評的卦，得先換模型上線、等應期回報才有數字。
// 換模型之前要先知道「會不會讀錯盤」（伏神爻位、動靜、用神旺衰），這支當場就看得到。
//
// 跑法（本機，會真的打 API、花錢：預設 6 題 × 3 模型 × 起卦＋追問，上限約 US$1）：
//   $env:ANTHROPIC_API_KEY="sk-ant-..."; node dev/model-ab.mts
//   node dev/model-ab.mts --models claude-sonnet-4-6,claude-sonnet-5-5 --out ab.md
//   node dev/model-ab.mts --persona persona.txt     # 換成線上某角色的 persona_prompt（預設用中性短句）
// 產出：Markdown 一份（預設 dev/model-ab-<日期>.md，不進版控），每題兩欄並排＋每次的 token 與美元。
//
// 看什麼：
//   1. 盤面事實：用神取哪一爻、旺衰、動爻與變爻、伏神——任何一句跟盤面不符就是不能換。
//   2. 追問有沒有接住初解（同一用神、不自打嘴巴）。
//   3. 成本欄：新 tokenizer 中文多三成，單價便宜不等於一次便宜。

(globalThis as Record<string, unknown>).Deno ??= { env: { get: (k: string) => process.env[k] } };
import { readFileSync, writeFileSync } from "node:fs";
const { buildChart } = await import("../supabase/functions/_shared/core.ts");
const { chartTextFull } = await import("../supabase/functions/_shared/dongyao.ts");
const { callInterpret } = await import("../supabase/functions/_shared/services.ts");

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MODELS = arg("models", "claude-sonnet-4-6,claude-sonnet-5-5,claude-haiku-5-5").split(",");
const OUT = arg("out", `dev/model-ab-${new Date().toISOString().slice(0, 10)}.md`);
const PERSONA = process.argv.includes("--persona") ? readFileSync(arg("persona", ""), "utf8")
  : "你是幾知觀的解卦人，說話沉穩、直接，照盤面講，不講盤面沒有的事。";
if (!process.env.ANTHROPIC_API_KEY) { console.error("先設 ANTHROPIC_API_KEY"); process.exit(1); }

// 單價（US$／百萬 token；與 model_prices 同值，快取寫入以 1h＝輸入 2 倍計）
const PRICE: Record<string, [number, number, number, number]> = {   // in, cacheWrite, cacheRead, out
  "claude-sonnet-4-6": [3, 6, 0.3, 15], "claude-sonnet-5-5": [2, 4, 0.2, 10], "claude-sonnet-5": [2, 4, 0.2, 10],
  "claude-haiku-5-5": [0.1, 0.2, 0.01, 0.5], "claude-haiku-4-5": [1, 2, 0.1, 5], "claude-opus-5-5": [4, 8, 0.2, 20],
};
const usd = (m: string, u: { in: number; out: number; cacheWrite: number; cacheRead: number }) => {
  const k = Object.keys(PRICE).find((p) => m.startsWith(p)); if (!k) return NaN;
  const [i, w, r, o] = PRICE[k];
  return (u.in * i + u.cacheWrite * w + u.cacheRead * r + u.out * o) / 1e6;
};

// 固定的六題：涵蓋有動爻／六爻安靜／多動、各種用神。lines 由初爻往上，6 老陰 7 少陽 8 少陰 9 老陽。
const CASES: { q: string; lines: number[]; date: [number, number, number, number]; follow: string }[] = [
  { q: "這次面試能不能錄取", lines: [7, 8, 9, 7, 8, 7], date: [2026, 10, 8, 10], follow: "大概什麼時候會有消息？" },
  { q: "下個月的業績能不能達標", lines: [8, 7, 7, 8, 7, 8], date: [2026, 10, 8, 14], follow: "要注意什麼？" },
  { q: "他對我還有沒有感情", lines: [6, 7, 8, 9, 8, 7], date: [2026, 10, 9, 21], follow: "我該主動聯絡嗎？" },
  { q: "這間房子該不該買", lines: [7, 7, 6, 8, 9, 8], date: [2026, 10, 10, 9], follow: "價格還有沒有空間？" },
  { q: "媽媽這次手術順不順利", lines: [8, 8, 7, 6, 7, 9], date: [2026, 10, 11, 8], follow: "術後恢復要多久？" },
  { q: "借出去的錢拿得回來嗎", lines: [9, 8, 8, 7, 6, 7], date: [2026, 10, 12, 16], follow: "要怎麼開口比較好？" },
];

type Run = { model: string; cast: string; follow: string; usdTotal: number; outTok: number; err?: string };
let md = `# 解卦模型並排（${new Date().toISOString().slice(0, 16)}）\n\n模型：${MODELS.join("、")}\n\n`;
const totals: Record<string, number> = {};
for (const [i, c] of CASES.entries()) {
  const chart = buildChart(c.lines, ...c.date);
  const ctext = chartTextFull(chart, c.q);
  const runs: Run[] = [];
  for (const model of MODELS) {
    try {
      const a = await callInterpret(PERSONA, ctext, { model });
      const b = await callInterpret(PERSONA, ctext, { model, followup: { prevReading: a.reading, question: c.follow, askLeft: 1 } });
      const cost = usd(a.model, a.usage) + usd(b.model, b.usage);
      runs.push({ model: a.model, cast: a.reading, follow: b.reading, usdTotal: cost, outTok: a.usage.out + b.usage.out });
      totals[model] = (totals[model] ?? 0) + cost;
      console.log(`#${i + 1} ${model}  US$${cost.toFixed(4)}`);
    } catch (e) {
      runs.push({ model, cast: "", follow: "", usdTotal: 0, outTok: 0, err: e instanceof Error ? e.message : String(e) });
      console.log(`#${i + 1} ${model}  ✗ ${runs.at(-1)!.err}`);
    }
  }
  md += `## ${i + 1}. ${c.q}\n\n<details><summary>盤面</summary>\n\n\`\`\`\n${ctext}\n\`\`\`\n</details>\n\n`;
  for (const r of runs) {
    md += `### ${r.model}${r.err ? "（失敗）" : `　US$${r.usdTotal.toFixed(4)}・輸出 ${r.outTok} token`}\n\n`;
    md += r.err ? `> ${r.err}\n\n` : `**初解**\n\n${r.cast}\n\n**追問：${c.follow}**\n\n${r.follow}\n\n`;
  }
}
md += `## 合計\n\n| 模型 | ${CASES.length} 題起卦＋追問 | 每卦（起卦＋一次追問）NT$ |\n|---|---|---|\n`;
for (const [m, v] of Object.entries(totals)) md += `| ${m} | US$${v.toFixed(4)} | ${(v / CASES.length * 32).toFixed(2)} |\n`;
writeFileSync(OUT, md);
console.log(`→ ${OUT}`);
