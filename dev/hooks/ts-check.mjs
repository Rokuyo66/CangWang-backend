// dev/hooks/ts-check.mjs — PostToolUse（Write|Edit|MultiEdit）
//
// 改到 supabase/functions/**/*.ts 或 dev/*.mts 後做語法檢查：
// 先用 Node 內建的 stripTypeScriptTypes 去型別（transform 模式，enum 等也吃），
// 再對產物 node --check。（直接 node --check 一支 .ts 不會去型別，會誤報。）
// 只抓語法錯，不跑測試——測試照 CLAUDE.md 在 commit 前交給 audit。
// 失敗時 exit 2：錯誤訊息回給 Claude 修，不會擋已完成的編輯。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInput, slash } from "./_io.mjs";

const input = await readInput();
const fp = input.tool_input?.file_path;
if (!fp || !existsSync(fp)) process.exit(0);
const norm = slash(fp);
if (!/\/supabase\/functions\/.+\.ts$|\/dev\/[^/]+\.mts$/.test(norm)) process.exit(0);
const short = norm.split("/").slice(-3).join("/");

function fail(msg) {
  const err = String(msg).split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l)).join("\n").trim();
  process.stderr.write(`語法檢查失敗（${short}）：\n${err}\n`);
  process.exit(2);
}

let js;
try {
  js = stripTypeScriptTypes(readFileSync(fp, "utf8"), { mode: "transform" });
} catch (e) {
  fail(e.message);
}

const dir = mkdtempSync(join(tmpdir(), "tscheck-"));
const out = join(dir, "check.mjs");
try {
  writeFileSync(out, js);
  execFileSync(process.execPath, ["--check", out], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 20000 });
} catch (e) {
  fail(String(e.stderr || e.message).replaceAll(out, short));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
