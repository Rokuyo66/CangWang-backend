// dev/build-form.mjs — 把案件填表工具打包成單一 HTML，直接用瀏覽器開。
//
// 與 build-play.mjs 同一套做法：借前端 repo 的 esbuild（後端 repo 是 Deno，不裝 node_modules）。
// 產物 dev/form.html 是純本機檔案，不進部署、不上 Cloudflare。
//
// 跑法：node dev/build-form.mjs

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

const tmp = mkdtempSync(join(tmpdir(), "guaform-"));
const out = join(tmp, "bundle.js");

try {
  execFileSync(esbuild, [
    "dev/form/entry.ts",
    "--bundle",
    "--format=iife",
    "--target=es2020",
    "--charset=utf8",
    `--outfile=${out}`,
  ], { stdio: "inherit" });

  const bundle = readFileSync(out, "utf8");
  const shell = readFileSync("dev/form/shell.html", "utf8");
  if (!shell.includes("/*BUNDLE*/")) throw new Error("shell.html 少了 /*BUNDLE*/ 佔位");

  const html = shell.replace("/*BUNDLE*/", () => bundle);
  writeFileSync("dev/form.html", html);
  const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
  console.log(`\n✅ dev/form.html  ${kb} KB`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
