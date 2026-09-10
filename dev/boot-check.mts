// dev/boot-check.mts — 部署前的「這份開得起來嗎」檢查
//
// 為什麼要這一支：2026-09-10 那次線上全掛，錯誤是
//   Uncaught SyntaxError: The requested module './rules.ts'
//   does not provide an export named 'fixGuaciChars'
// ——送上去的 services.ts 是新的、rules.ts 是舊的。這種「模組之間對不起來」
// 不會在編輯器裡紅字，也不會在部署指令裡報錯，要等到雲端起不了機、
// 而每一支請求都變成 BOOT_ERROR 之後才看得見。從觀主的角度看是「整個觀不見了」。
//
// 而它其實只要「把每個模組真的載入一次」就會現形：ESM 在 link 階段就會比對
// import 與 export 的名字。node 剝掉型別之後跑的就是真的 ESM，這裡因此
// 不需要 Deno、不需要部署、不需要網路，一秒之內給答案。
//
// 跑法：node dev/boot-check.mts　（部署前跑，見 deploy-howto.md 第 0 步）

// services.ts 等在載入時就會讀 Deno.env（模型名、額度預設值），node 沒有這個全域。
// 擺一個只會回 undefined 的替身，讓它們全部走預設值（同各支 *-test.mts）。
(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };

import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dirname, "../supabase/functions/_shared");
const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

let bad = 0;
console.log(`\n模組連結檢查　${files.length} 支\n`);
for (const f of files) {
  try {
    await import(pathToFileURL(join(DIR, f)).href);
    console.log("  ✅ " + f);
  } catch (e) {
    bad++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log("  ❌ " + f + "\n     " + msg);
  }
}

// 三支 Edge Function 的進入點不在這裡檢（index.ts 一載入就 Deno.serve、
// 還要真的環境變數），但它們用的東西全在 _shared——那一層對得起來，
// 進入點就只剩自己那幾行。
console.log(bad ? `\n❌ ${bad} 支載入失敗——這份送上去會 BOOT_ERROR，先修再部署。\n`
                : `\n✅ 全部載得起來。\n`);
process.exit(bad ? 1 : 0);
