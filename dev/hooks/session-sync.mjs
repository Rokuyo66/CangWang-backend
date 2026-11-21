// dev/hooks/session-sync.mjs — SessionStart
//
// 六六兩台機器開發，本機隨時可能落後（曾用落後檔案部署，把另一台的線上改動蓋掉）。
// 開工時 fetch 前後端兩個 repo，落後 origin/main 或工作區髒了就提醒。
// 只提醒、不 pull：dirty 工作區 pull 曾把上游 commit 蓋掉，要不要 pull 由人決定。
//
// 前端路徑預設 D:/CangWang-web，另一台機器不同就設環境變數 CANGWANG_WEB_DIR。
import { existsSync } from "node:fs";
import { readInput, git, slash } from "./_io.mjs";

const input = await readInput();
const here = slash(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

const roots = new Set();
const top = git(here, ["rev-parse", "--show-toplevel"])?.trim();
if (top) {
  roots.add(slash(top));
  // 在 worktree 裡的話，也看主 checkout（部署是從主 checkout 的 main 推）
  const main = (git(top, ["worktree", "list", "--porcelain"]) || "").match(/^worktree (.+)$/m)?.[1];
  if (main) roots.add(slash(main));
}
const web = slash(process.env.CANGWANG_WEB_DIR || "D:/CangWang-web");
if (existsSync(`${web}/.git`)) roots.add(web);

const fetched = new Set();
const warn = [];
const ok = [];
for (const r of roots) {
  const common = slash(git(r, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim() || r);
  if (!fetched.has(common)) {
    if (git(r, ["fetch", "--quiet", "--prune"], 20000) === null) warn.push(`${r}：git fetch 失敗（離線？），以下比對可能過時`);
    fetched.add(common);
  }
  const branch = git(r, ["branch", "--show-current"])?.trim() || "(detached)";
  const behindMain = +(git(r, ["rev-list", "--count", "HEAD..origin/main"])?.trim() || 0);
  const behindUp = +(git(r, ["rev-list", "--count", "HEAD..@{u}"])?.trim() || 0);
  const dirty = (git(r, ["status", "--porcelain", "--untracked-files=no"]) || "").split("\n").filter(Boolean).length;

  const issues = [];
  if (behindUp) issues.push(`落後自己的 upstream ${behindUp} 個 commit`);
  if (behindMain && (branch === "main" || !behindUp)) issues.push(`缺 origin/main 的 ${behindMain} 個 commit`);
  if (dirty) issues.push(`有 ${dirty} 個已追蹤檔案未 commit（先別 pull）`);
  (issues.length ? warn : ok).push(`${r} [${branch}]${issues.length ? "：" + issues.join("；") : "：已同步"}`);
}

const lines = ["【repo 同步檢查】"];
for (const w of warn) lines.push("⚠ " + w);
for (const o of ok) lines.push("✓ " + o);
if (warn.length) lines.push("要部署或在 main 上動工前，先處理上面的 ⚠（乾淨工作區才 pull；部署一律從剛 pull 完的 main）。");
process.stdout.write(lines.join("\n") + "\n");
process.exit(0);
