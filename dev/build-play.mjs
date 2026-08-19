// dev/build-play.mjs — 把卦案原型打包成單一 HTML，直接用瀏覽器開。
//
// 借前端 repo 的 esbuild（後端 repo 是 Deno，不裝 node_modules）。
// 產物 dev/play.html 是純本機檔案，不進部署、不上 Cloudflare。
//
// 跑法：node dev/build-play.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 直接指平台 binary：Windows 上 .bin/esbuild.cmd 沒有 shell 起不來
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

const tmp = mkdtempSync(join(tmpdir(), "guaplay-"));
const out = join(tmp, "bundle.js");

try {
  execFileSync(esbuild, [
    "dev/play/entry.ts",
    "--bundle",
    "--format=iife",
    "--target=es2020",
    "--charset=utf8",
    `--outfile=${out}`,
  ], { stdio: "inherit" });

  const bundle = readFileSync(out, "utf8");
  const shell = readFileSync("dev/play/shell.html", "utf8");
  if (!shell.includes("/*BUNDLE*/")) throw new Error("shell.html 少了 /*BUNDLE*/ 佔位");

  const html = shell.replace("/*BUNDLE*/", () => bundle);
  writeFileSync("dev/play.html", html);
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
  console.log(`\n✅ dev/play.html  ${kb} KB`);
  if (kb > 900) console.log("⚠ 檔案偏大，檢查是不是把不該進來的東西打包了");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
