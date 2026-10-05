// dev/design/tokens/build.mjs — 美術與動態 token 的唯一出口。
//
// 唯一真相是 dev/design/tokens.json。這支把它寫進每一個落點裡的「生成區」：
//
//   /* @design:begin 名字 v=<token 檔指紋> #<這一段的指紋>（由後端 dev/design/tokens.json 產生，不要手改） */
//   …產生的內容…
//   /* @design:end 名字 */
//
// （JS／Java／TS 用 // 註解，其餘一樣。）生成區以外的字一個都不動。
// 前端 build.mjs 會重算每一段的指紋：有人手改生成區、或各段不是同一次產生的，build 直接失敗。
//
// 跑法：
//   node dev/design/tokens/build.mjs --web ../CangWang-web        寫入後端與前端所有落點
//   node dev/design/tokens/build.mjs --web ../CangWang-web --check  只檢查，不寫（有落差就以 1 結束）
//   不給 --web 就只處理後端這邊（規範頁、動態原型、小工具原型）。
//
// 落點清單（新增落點就加在 TARGETS，並在 dev/design/README.md 的表上補一列）：
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const BACK = resolve(here, "../../..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const webArg = args.includes("--web") ? args[args.indexOf("--web") + 1] : null;
const WEB = webArg ? resolve(process.cwd(), webArg) : null;
if (WEB && !existsSync(join(WEB, "build.mjs"))) throw new Error(`--web ${webArg}：找不到前端 repo（沒有 build.mjs）`);

const raw = readFileSync(join(BACK, "dev/design/tokens.json"), "utf8");
const T = JSON.parse(raw);
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const V = sha(raw);

/* ── 共用：主題、算式 ── */
const THEMES = T.themes.order;
const meta = (t) => T.themes.meta[t];
const DARK = THEMES.filter((t) => meta(t).dark);
const darkSel = DARK.map((t) => `[data-theme="${meta(t).key}"]`).join(",");
const val = (t, k) => T.themes.values[t][k];
const byGroup = () => {
  const g = new Map();
  for (const tok of T.themes.tokens) { if (!g.has(tok.g)) g.set(tok.g, []); g.get(tok.g).push(tok.k); }
  return [...g.values()];
};
const btn = (k) => T.buttons.types.find((b) => b.k === k);
const linkExpr = (b, part, dark) => {
  const v = b.link[part];
  if (v === "LIGHTFACE") return dark ? "var(--paper-2)" : "color-mix(in srgb, var(--paper) 45%, #fff)";
  if (v && typeof v === "object") return dark ? v.d : v.l;
  return v;
};
const M = T.motion;
const ms = (x) => (x >= 1000 ? `${+(x / 1000).toFixed(2)}s` : `${x}ms`);
const ease = (e, ovVar) => e.v.replace("OV", ovVar);
const javaHex = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) throw new Error(`小工具色要是 #RRGGBB：${c}`);
  return "0xFF" + m[1].toUpperCase();
};

/* ── 各生成區的內容 ── */
const gen = {
  // 前端：五套主題色碼（src/base/00-tokens-themes.css 的 :root 與各 [data-theme]）
  theme: (t) => byGroup().map((ks) => "    " + ks.map((k) => `--${k}:${val(t, k)};`).join(" ")).join("\n"),

  // 前端：動態 token（styles/motion.css 的 :root）
  webMotion: () => {
    const b = M.base, L = [];
    L.push(`  --m-k:${b.k};          /* 速度倍率：所有時長 × k */`);
    L.push(`  --m-a:${b.a};          /* 待機幅度倍率 */`);
    L.push(`  --m-d:${b.d}px;      /* 元件厚度＝按壓深度 */`);
    L.push(`  --m-ov:${b.ov};      /* 回彈過衝量 */`);
    L.push(`  --m-tilt:${b.tilt}deg;   /* 按壓傾斜上限 */`, "");
    for (const d of M.durations) L.push(`  ${(d.web + ":").padEnd(13)}calc(${ms(d.ms).padEnd(6)} * var(--m-k));   /* ${d.u} */`);
    L.push("");
    for (const e of M.easings) L.push(`  ${(e.web + ":").padEnd(14)}${ease(e, "var(--m-ov)")};   /* ${e.u} */`);
    L.push("");
    L.push(`  --m-amp-move: calc(${M.amp.move}px  * var(--m-a));`);
    L.push(`  --m-amp-scale:calc(${M.amp.scale} * var(--m-a));`);
    L.push(`  --m-amp-rot:  calc(${M.amp.rot}deg * var(--m-a));`);
    return L.join("\n");
  },

  // 前端：按鈕四型（styles/motion.css「A 互動回饋」）。text 是 .btn 本身，其餘疊在 .btn 上
  webButtons: () => {
    const L = [], tx = btn("text");
    const rule = (sel, b, dark) => `${sel}{ --m-edge:${linkExpr(b, "edge", dark)}; background:${linkExpr(b, "face", dark)}; border-color:${linkExpr(b, "border", dark)}; color:${linkExpr(b, "text", dark)} }`;
    L.push(rule(tx.web, tx, false));
    const solid = T.buttons.types.filter((b) => !b.stage && b.k !== "text");
    L.push(`:is(${darkSel}) ${tx.web}${solid.map((b) => `:not(${b.web.replace(tx.web, "")})`).join("")}{ background:${linkExpr(tx, "face", true)} }`);
    L.push(`${tx.web}:hover{ border-color:${tx.hover.border}; color:${tx.hover.text} }`);
    for (const b of solid) L.push(rule(`${b.web}, ${b.web}:hover`, b, false));
    // 斷開連動時：各主題單獨設的值（custom[主題][元件][零件]）
    if (!T.buttons.linked) for (const t of THEMES) for (const b of T.buttons.types) {
      const c = T.buttons.custom?.[t]?.[b.k]; if (!c || b.stage) continue;
      const map = { face: "background", border: "border-color", edge: "--m-edge", text: "color" };
      const decl = Object.entries(c).map(([p, v]) => `${map[p]}:${v}`).join("; ");
      if (decl) L.push(`${t === "xuan" ? "" : `[data-theme="${meta(t).key}"] `}${b.web}${b.k === "text" ? "" : `, ${t === "xuan" ? "" : `[data-theme="${meta(t).key}"] `}${b.web}:hover`}{ ${decl} }`);
    }
    return L.join("\n");
  },

  // 前端：兩段開關六色（styles/motion.css 的 --seg-*）
  webSeg: () => {
    const s = btn("seg"), L = [];
    L.push("body{");
    for (const [p, pn] of s.parts) L.push(`  --seg-${p}:${linkExpr(s, p, false)};   /* ${pn} */`);
    L.push("}");
    const darkParts = s.parts.filter(([p]) => typeof s.link[p] === "object");
    L.push(`:is(${darkSel}){`);
    for (const [p, pn] of darkParts) L.push(`  --seg-${p}:${linkExpr(s, p, true)};   /* ${pn}（深色主題不從墨推） */`);
    L.push("}");
    if (!T.buttons.linked) for (const t of THEMES) {
      const c = T.buttons.custom?.[t]?.seg; if (!c) continue;
      L.push(`${t === "xuan" ? "body" : `[data-theme="${meta(t).key}"]`}{ ${Object.entries(c).map(([p, v]) => `--seg-${p}:${v}`).join("; ")} }`);
    }
    return L.join("\n");
  },

  // 前端：給 JS 用的同一份數字（src/app/design-tokens.js 整檔）
  webJs: () => {
    const o = { version: T.version, themes: Object.fromEntries(THEMES.map((t) => [meta(t).key, { name: meta(t).name, dark: !!meta(t).dark }])),
      motion: { ...M.base, ms: Object.fromEntries(M.durations.map((d) => [d.k, d.ms])), ease: Object.fromEntries(M.easings.map((e) => [e.k, e.v.replace("OV", M.base.ov)])), amp: { move: M.amp.move, scale: M.amp.scale, rot: M.amp.rot } } };
    return `const DESIGN = Object.freeze(${JSON.stringify(o, null, 2)});`;
  },

  // 小工具：Palette.of() 的五套（android/.../widget/Palette.java）
  java: () => {
    const f = ["card", "line", "ink", "dim", "gold", "seal"].map((k) => T.widget.map[k]);
    const row = (t) => `new Palette(${f.map((k) => javaHex(val(t, k))).join(", ")});   // ${meta(t).name}`;
    const L = [];
    for (const t of THEMES.filter((t) => t !== "xuan")) L.push(`    if ("${meta(t).key}".equals(key))`, `      return ${row(t)}`);
    L.push(`    // ${meta("xuan").key}（${meta("xuan").name}）＝內建預設，也是任何沒認出來的 key 的退路`, `    return ${row("xuan")}`);
    return L.join("\n");
  },

  // 後端：規範頁（dev/design/style/index.html）用的清單與算式
  specJs: () => `  const DESIGN = ${JSON.stringify({ version: T.version, themes: { order: THEMES, meta: T.themes.meta, tokens: T.themes.tokens, values: T.themes.values }, buttons: T.buttons })};`,

  // 後端：動態原型（dev/design/motion/prototype.html）的 :root token
  protoCss: () => {
    const b = M.base, L = [];
    L.push(`  --k:${b.k};          /* 速度倍率：所有時長 × k */`, `  --a:${b.a};          /* 待機幅度倍率 */`,
      `  --d:${b.d}px;      /* 按壓深度（元件厚度）；元件用 --dk 取比例，不直接覆寫 --d */`, `  --ov:${b.ov};      /* 回彈過衝量 */`, `  --tilt:${b.tilt}deg;    /* 按壓傾斜上限 */`, "");
    for (const d of M.durations) L.push(`  ${(d.spec + ":").padEnd(12)}calc(${ms(d.ms).padEnd(6)} * var(--k));`);
    L.push("");
    for (const e of M.easings) L.push(`  ${(e.spec + ":").padEnd(11)}${ease(e, "var(--ov)")};`);
    L.push("", `  --amp-move: calc(${M.amp.move}px  * var(--a));`, `  --amp-scale:calc(${M.amp.scale} * var(--a));`, `  --amp-rot:  calc(${M.amp.rot}deg * var(--a));`);
    return L.join("\n");
  },
  // 後端：動態原型裡 JS 用的同一份（token 表、總控預設值、給人複製的範例碼都讀它）
  protoJs: () => `  const MOTION = ${JSON.stringify(M)};`,

  // 後端：小工具原型（dev/widget/entry.ts）。只產生跟 App 同一組的六個色，背板與材質是原型自己的
  widgetTs: () => {
    const L = ["const APP_COLORS: Record<string, { mode: \"light\" | \"dark\"; card: string; line: string; ink: string; dim: string; gold: string; seal: string }> = {"];
    for (const t of THEMES) {
      const m = T.widget.map;
      L.push(`  ${t}: { mode: "${meta(t).dark ? "dark" : "light"}", card: "${val(t, m.card)}", line: "${val(t, m.line)}", ink: "${val(t, m.ink)}", dim: "${val(t, m.dim)}", gold: "${val(t, m.gold)}", seal: "${val(t, m.seal)}" },   // ${meta(t).name}`);
    }
    L.push("};");
    return L.join("\n");
  },
};

/* ── 落點 ── */
const TARGETS = [
  { side: "back", file: "dev/design/style/index.html", c: "//", regions: { "spec-design": gen.specJs } },
  { side: "back", file: "dev/design/motion/prototype.html", c: "/*", regions: { "proto-motion": gen.protoCss } },
  { side: "back", file: "dev/design/motion/prototype.html", c: "//", regions: { "proto-motion-js": gen.protoJs } },
  { side: "back", file: "dev/widget/entry.ts", c: "//", regions: { "widget-colors": gen.widgetTs } },
  { side: "web", file: "src/base/00-tokens-themes.css", c: "/*", regions: Object.fromEntries(THEMES.map((t) => [`theme-${t}`, () => gen.theme(t)])) },
  { side: "web", file: "src/styles/motion.css", c: "/*", regions: { motion: gen.webMotion, buttons: gen.webButtons, seg: gen.webSeg } },
  { side: "web", file: "src/app/design-tokens.js", c: "//", regions: { "design-js": gen.webJs } },
  { side: "web", file: "android/app/src/main/java/com/cangwang/jizhiguan/widget/Palette.java", c: "//", regions: { palette: gen.java } },
];

const open = (c) => (c === "/*" ? ["/* ", " */"] : ["// ", ""]);
function writeRegion(text, name, body, c, file) {
  const [o, x] = open(c);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 名字後面一定接空白、換行或註解收尾：proto-motion 不能吃到 proto-motion-js
  const re = new RegExp(`([ \\t]*)${esc(o)}@design:begin ${esc(name)}(?=[ \\n*])[^\\n]*\\n(?:[\\s\\S]*?\\n)?[ \\t]*${esc(o)}@design:end ${esc(name)}${esc(x)}(?=\\s|$)`);
  const m = re.exec(text);
  if (!m) throw new Error(`${file}：找不到生成區 ${name}（要先手動放一對 ${o}@design:begin ${name}${x} … ${o}@design:end ${name}${x}）`);
  const ind = m[1];
  const block = `${ind}${o}@design:begin ${name} v=${V} #${sha(body)}（由後端 dev/design/tokens.json 產生，不要手改）${x}\n${body}\n${ind}${o}@design:end ${name}${x}`;
  return text.slice(0, m.index) + block + text.slice(m.index + m[0].length);
}

let drift = 0, wrote = 0;
for (const tg of TARGETS) {
  if (tg.side === "web" && !WEB) continue;
  const path = join(tg.side === "web" ? WEB : BACK, tg.file);
  const before = readFileSync(path, "utf8");
  let after = before;
  for (const [name, fn] of Object.entries(tg.regions)) after = writeRegion(after, name, fn(), tg.c, tg.file);
  if (after === before) continue;
  drift++;
  if (CHECK) { console.log(`✗ ${tg.side === "web" ? "前端" : "後端"} ${tg.file}：與 tokens.json 不一致`); continue; }
  writeFileSync(path, after); wrote++;
  console.log(`✎ ${tg.side === "web" ? "前端" : "後端"} ${tg.file}`);
}
if (CHECK) { console.log(drift ? `\n有 ${drift} 個落點跟 tokens.json 對不上：跑一次不帶 --check 的就會寫齊。` : "✅ 所有落點都跟 tokens.json 一致"); process.exit(drift ? 1 : 0); }
console.log(wrote ? `\n✅ 寫了 ${wrote} 個檔（token 檔指紋 ${V}）。規範頁要重產：node dev/design/style/build.mjs` : "✅ 全部已是最新");
if (!WEB) console.log("（沒給 --web，前端的落點沒動。前端 repo 路徑：--web ../CangWang-web）");
