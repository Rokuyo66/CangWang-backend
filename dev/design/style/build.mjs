// dev/design/style/build.mjs — 把美術規範組成一份可發佈的頁面（spec.html）。
//
// index.html 是原始檔。基準（站上現值）＝ dev/design/tokens.json（唯一真相）；state.json 只放規範頁上「改到一半、還沒套用」的值與修改歷史。
// 動態規範（../motion/prototype.html）整份嵌進 <template id="motionSrc">，頁面裡用 iframe 顯示並灌色碼。
// 產物 spec.html 就是發佈成 artifact 的那一份。
//
// 跑法：node dev/design/style/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "index.html"), "utf8");
const motion = readFileSync(join(here, "../motion/prototype.html"), "utf8");
const state = JSON.parse(readFileSync(join(here, "state.json"), "utf8"));
const tokens = JSON.parse(readFileSync(join(here, "../tokens.json"), "utf8"));
// 基準一律從 tokens.json 來；state.json 沒有待套用的就等於基準
state.version = tokens.version;
state.baseline = tokens.themes.values;
if (!state.themes) state.themes = tokens.themes.values;
if (!state.buttons) state.buttons = { linked: tokens.buttons.linked, custom: tokens.buttons.custom };

if (!page.includes("<!--MOTION-->") || !page.includes("/*STATE*/")) throw new Error("index.html 少了 <!--MOTION--> 或 /*STATE*/ 佔位");
if (motion.includes("</template>")) throw new Error("動態規範裡有 </template>，會把嵌入切斷");
const json = JSON.stringify(state).replace(/</g, "\\u003c");   // JSON 放在 <script> 裡：不能出現 </script>
const out = page.replace("<!--MOTION-->", () => motion).replace("/*STATE*/", () => json);
writeFileSync(join(here, "spec.html"), out);
console.log(`✅ dev/design/style/spec.html  ${(Buffer.byteLength(out) / 1024).toFixed(0)} KB`);
