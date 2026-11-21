// dev/hooks/_io.mjs — hooks 共用：讀 stdin 的 JSON、跑 git、擋下（exit 2）。
import { execFileSync } from "node:child_process";

export async function readInput() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

// 成功回 stdout 字串（可能是 ""），失敗回 null。不會丟例外、不會跳密碼提示。
export function git(cwd, args, timeout = 10000) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch { return null; }
}

// exit 2 ＝ 擋下這次工具呼叫，stderr 會交給 Claude 看。
export function block(msg) {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

export const slash = (p) => String(p || "").replace(/\\/g, "/");
