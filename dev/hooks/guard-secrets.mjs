// dev/hooks/guard-secrets.mjs — PreToolUse（Write|Edit|MultiEdit|Bash|PowerShell）
//
// 擋兩件事：
// 1. 把金鑰原文寫進檔案或指令：Supabase access token（sbp_）、GitHub token、service_role JWT。
//    anon／publishable key 是公開的，不擋（前端本來就內嵌）。
//    正確作法：token 從憑證管理員現讀（dev/lib/cred.ps1、git credential fill），只放在變數裡。
// 2. git add 只留家用機的檔（0017_reminders.sql、*webhook*.txt）。
import { readInput, block } from "./_io.mjs";

const input = await readInput();
const ti = input.tool_input || {};
const texts = [ti.content, ti.new_string, ti.command, ...(Array.isArray(ti.edits) ? ti.edits : []).map((e) => e?.new_string)]
  .filter((t) => typeof t === "string");
if (!texts.length) process.exit(0);
const all = texts.join("\n");

const found = [];
if (/\bsbp_[A-Za-z0-9]{20,}/.test(all)) found.push("Supabase access token（sbp_…）");
if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/.test(all) || /\bgithub_pat_[A-Za-z0-9_]{40,}/.test(all)) {
  found.push("GitHub token");
}
for (const jwt of all.match(/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g) || []) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    if (payload?.role === "service_role") { found.push("Supabase service_role key"); break; }
  } catch { /* 不是合法 JWT 就略過 */ }
}
if (/\bsb_secret_[A-Za-z0-9_-]{20,}/.test(all)) found.push("Supabase secret key（sb_secret_…）");

if (found.length) {
  block(
    `偵測到金鑰原文：${[...new Set(found)].join("、")}。已擋下，請勿把金鑰寫進檔案或指令。\n` +
    `改用變數：Supabase 走 dev/lib/cred.ps1 的 Get-SupabaseToken，GitHub 走 git credential fill。`,
  );
}

// 只看 git add／git stage 那一段指令的參數，commit 訊息裡提到檔名不算
if (typeof ti.command === "string") {
  for (const seg of ti.command.split(/[\n;|&]+/)) {
    if (/^\s*git\s+(?:-C\s+\S+\s+)?(?:add|stage)\b/.test(seg) &&
        /0017_reminders\.sql|webhook[^\s]*\.txt/i.test(seg)) {
      block("0017_reminders.sql／*webhook*.txt 只留本機，不進 repo。");
    }
  }
}

process.exit(0);
