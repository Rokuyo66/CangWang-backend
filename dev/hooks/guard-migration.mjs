// dev/hooks/guard-migration.mjs — PreToolUse（Write|Edit|MultiEdit）
//
// 1. 0017_reminders.sql 只留家用機：一律不碰。
// 2. 已在 origin/main 的 migration 視為已上線：不准改。改了 dev/migrate.ps1 會因雜湊不符吼，
//    而且線上不會重跑——要修就開新編號。
// 3. 新建 migration 時，編號不能跟本機或任何遠端分支上已有的檔撞（各分支常互撞，見 0107–0111）。
//
// 想刻意繞過（例如改一支已併入但確定沒上線的檔）：自己在編輯器裡改，不經 Claude。
import { existsSync, readdirSync } from "node:fs";
import { readInput, git, block, slash } from "./_io.mjs";

const input = await readInput();
const fp = input.tool_input?.file_path;
if (!fp) process.exit(0);

const norm = slash(fp);
const m = norm.match(/(?:^|\/)supabase\/migrations\/((\d{4})_[^/]+\.sql)$/i);
if (!m) process.exit(0);

const [, file, num] = m;
const rel = `supabase/migrations/${file}`;
const root = norm.slice(0, norm.length - rel.length).replace(/\/$/, "") || slash(input.cwd);

if (file.toLowerCase() === "0017_reminders.sql") {
  block("0017_reminders.sql 只留家用機：不推 repo、不改、不執行（表已在線上運作）。");
}

if (git(root, ["cat-file", "-e", `origin/main:${rel}`]) !== null) {
  block(
    `${rel} 已在 origin/main，視為已上線。改內容不會重跑，只會讓 migrate.ps1 的雜湊對不上。\n` +
    `要修正請開一支新編號的 migration。`,
  );
}

if (!existsSync(fp)) {
  const hits = new Map(); // 檔名 → 在哪些地方
  const hit = (f, where) => hits.set(f, [...(hits.get(f) || []), where]);
  const nums = new Set();
  const dir = `${root}/supabase/migrations`;
  try {
    for (const f of readdirSync(dir)) {
      const n = f.match(/^(\d{4})_/)?.[1];
      if (n) nums.add(+n);
      if (n === num && f !== file) hit(f, "本機");
    }
  } catch { /* 目錄不存在就只看遠端 */ }

  const refs = (git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"]) || "")
    .split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/HEAD"))
    .map((s) => s.replace(/^refs\/remotes\//, ""));
  for (const ref of refs) {
    const ls = git(root, ["ls-tree", "--name-only", ref, "supabase/migrations/"]) || "";
    for (const line of ls.split("\n")) {
      const f = line.replace(/^supabase\/migrations\//, "").trim();
      const n = f.match(/^(\d{4})_/)?.[1];
      if (!n) continue;
      nums.add(+n);
      if (n === num && f !== file) hit(f, ref);
    }
  }

  if (hits.size) {
    const next = String(Math.max(0, ...nums) + 1).padStart(4, "0");
    const list = [...hits].map(([f, where]) => {
      const w = [...new Set(where)];
      const shown = w.filter((x) => x === "本機" || x === "origin/main");
      const others = w.length - shown.length;
      return `${f}（${[...shown, others ? `另 ${others} 個遠端分支` : ""].filter(Boolean).join("、")}）`;
    });
    block(
      `migration 編號 ${num} 已被佔用：\n  - ${list.join("\n  - ")}\n` +
      `請改用 ${next}（本機＋所有遠端分支的最大號 +1）。`,
    );
  }
}

process.exit(0);
