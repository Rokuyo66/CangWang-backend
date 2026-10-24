// dev/jianwen-seed.mjs — 見聞設定（dev/design/journal/jianwen.json，從企劃工作臺 jianghu_cfg/world 存下來）印成 SQL。
// 用法：node dev/jianwen-seed.mjs >> supabase/migrations/00xx_….sql
import { readFileSync } from "node:fs";
const w = JSON.parse(readFileSync("dev/design/journal/jianwen.json", "utf8"));
console.log(`update jianghu_config set world = $jw$${JSON.stringify(w)}$jw$::jsonb where id = 'main';`);
