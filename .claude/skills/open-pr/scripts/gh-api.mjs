// gh-api.mjs — 沒有 gh CLI 時開／併 PR、刪遠端分支（GitHub REST API，走 curl）。
//
//   node .claude/skills/open-pr/scripts/gh-api.mjs open   --repo CangWang-backend --head <branch> [--base main] --title "…" --body-file <path>
//   node .claude/skills/open-pr/scripts/gh-api.mjs merge  --repo CangWang-backend --number 93
//   node .claude/skills/open-pr/scripts/gh-api.mjs delete-branch --repo CangWang-backend --head <branch>
//   node .claude/skills/open-pr/scripts/gh-api.mjs view   --repo CangWang-backend --number 93
//
// token 從 git credential fill 現拿，只放在記憶體與 curl 的 header 參數裡，不印出。
// JSON body 一律寫暫存檔再 --data-binary @file（inline 含中文會 Problems parsing JSON）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
const owner = opt.owner || "Rokuyo66";
if (!cmd || !opt.repo) die("用法見檔頭註解");

const cred = execFileSync("git", ["credential", "fill"], {
  input: "protocol=https\nhost=github.com\n\n",
  encoding: "utf8",
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});
const token = cred.match(/^password=(.+)$/m)?.[1];
if (!token) die("git credential fill 拿不到 github.com 的 token");

const base = `https://api.github.com/repos/${owner}/${opt.repo}`;

function api(method, path, body) {
  const dir = mkdtempSync(join(tmpdir(), "ghapi-"));
  const args = ["-s", "-w", "\n%{http_code}", "-X", method, base + path,
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (body) {
    const f = join(dir, "body.json");
    writeFileSync(f, JSON.stringify(body), "utf8");
    args.push("-H", "Content-Type: application/json; charset=utf-8", "--data-binary", `@${f}`);
  }
  try {
    let out;
    try {
      out = execFileSync("curl.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      // 例外訊息會帶整條命令列（含 Authorization header），只回報結束碼
      die(`curl 失敗（exit ${e.status ?? "?"}）：離線、DNS 或 TLS 問題？`);
    }
    const i = out.lastIndexOf("\n");
    const code = +out.slice(i + 1);
    let json = null;
    try { json = JSON.parse(out.slice(0, i) || "null"); } catch { /* 204 等空 body */ }
    return { code, json };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function die(msg) { console.error("✗ " + msg); process.exit(1); }
function need(...keys) { for (const k of keys) if (!opt[k]) die(`缺 --${k}`); }

if (cmd === "open") {
  need("head", "title", "body-file");
  const body = readFileSync(opt["body-file"], "utf8");
  const r = api("POST", "/pulls", { title: opt.title, head: opt.head, base: opt.base || "main", body });
  if (r.code !== 201) die(`開 PR 失敗（HTTP ${r.code}）：${r.json?.message || ""} ${JSON.stringify(r.json?.errors || "")}`);
  console.log(`✓ PR #${r.json.number}：${r.json.html_url}`);
} else if (cmd === "merge") {
  need("number");
  const r = api("PUT", `/pulls/${opt.number}/merge`, { merge_method: opt.method || "merge" });
  if (r.code !== 200) die(`合併失敗（HTTP ${r.code}）：${r.json?.message || ""}`);
  console.log(`✓ 已合併 #${opt.number}（${r.json.sha?.slice(0, 7)}）`);
} else if (cmd === "delete-branch") {
  need("head");
  if (/^(main|master)$/.test(opt.head)) die("不刪 main");
  const r = api("DELETE", `/git/refs/heads/${opt.head}`);
  if (r.code !== 204) die(`刪分支失敗（HTTP ${r.code}）：${r.json?.message || ""}`);
  console.log(`✓ 已刪遠端分支 ${opt.head}`);
} else if (cmd === "view") {
  need("number");
  const r = api("GET", `/pulls/${opt.number}`);
  if (r.code !== 200) die(`讀取失敗（HTTP ${r.code}）`);
  const p = r.json;
  console.log(`#${p.number} ${p.title}\n狀態：${p.state}${p.merged ? "（已合併）" : ""}  mergeable=${p.mergeable}\n${p.head.ref} → ${p.base.ref}\n${p.html_url}`);
} else die(`不認得的指令 ${cmd}`);
