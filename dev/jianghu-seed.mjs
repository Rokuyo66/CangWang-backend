// dev/jianghu-seed.mjs — 把 dev/design/journal/jianghu/*.json（從稿紙存下來的劇本）印成 upsert SQL。
// 用法：node dev/jianghu-seed.mjs > supabase/migrations/00xx_jianghu_<名>.sql，再照常 migrate。
// 只有 status 是 final 或 temp（或 --all）的才上架；其他照樣寫進表、published=false。
import { readdirSync, readFileSync } from "node:fs";
const dir = "dev/design/journal/jianghu", all = process.argv.includes("--all");
const files = readdirSync(dir).filter((f) => /^gua_\d\d\.json$/.test(f)).sort();
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
for (const f of files) {
  const d = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const pub = all || ["final", "temp", "review"].includes(d.status);
  const tag = "$jh" + d.gua_no + "$";
  console.log(`insert into jianghu_events (gua_no, gua, title, doc, published) values
  (${d.gua_no}, ${q(d.gua)}, ${q(d.title)}, ${tag}${JSON.stringify(d)}${tag}::jsonb, ${pub})
on conflict (gua_no) do update set gua = excluded.gua, title = excluded.title, doc = excluded.doc,
  published = excluded.published, updated_at = now();
`);
}
