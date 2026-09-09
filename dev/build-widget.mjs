// dev/build-widget.mjs — 把桌面小工具原型打包成單一 HTML，直接用瀏覽器開。
//
// 與 build-play.mjs 同一套作法（借前端 repo 的 esbuild；後端 repo 是 Deno，不裝 node_modules）。
// 產物 dev/widget.html 是純本機檔案，不進部署、不上 Cloudflare。
//
// 值得說一句的是它 bundle 進去的東西：entry.ts 直接 import
// supabase/functions/_shared 的 core／jieqi／qian60／widget 四支。
// 那不是為了省事，是為了讓原型畫出來的干支、節氣、行止、籤詩與伺服器同一份程式——
// 原型與實作各寫一份文案，是設計稿最容易騙人的地方。
// 也因此 _shared/widget.ts 必須是純的（不碰 supabase、不讀 Deno.env），見該檔開頭。
//
// 跑法：node dev/build-widget.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ESBUILD_CANDIDATES = [
  "D:/CangWang-web/node_modules/@esbuild/win32-x64/esbuild.exe",
  "D:/CangWang-web/node_modules/@esbuild/darwin-arm64/bin/esbuild",
  "D:/CangWang-web/node_modules/@esbuild/linux-x64/bin/esbuild",
  "esbuild",
];
const esbuild = ESBUILD_CANDIDATES.find((p) => p === "esbuild" || existsSync(p));
if (!esbuild) {
  console.error("找不到 esbuild。前端 repo 需先 npm install，或全域安裝 esbuild。");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "guawidget-"));
const out = join(tmp, "bundle.js");

try {
  execFileSync(esbuild, [
    "dev/widget/entry.ts",
    "--bundle",
    "--format=iife",
    "--target=es2020",
    "--charset=utf8",
    `--outfile=${out}`,
  ], { stdio: "inherit" });

  const bundle = readFileSync(out, "utf8");
  const shell = readFileSync("dev/widget/shell.html", "utf8");
  if (!shell.includes("/*BUNDLE*/")) throw new Error("shell.html 少了 /*BUNDLE*/ 佔位");

  const html = shell.replace("/*BUNDLE*/", () => bundle);
  writeFileSync("dev/widget.html", html);
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
  console.log(`\n✅ dev/widget.html  ${kb} KB`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
