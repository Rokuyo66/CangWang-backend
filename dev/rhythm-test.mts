// dev/rhythm-test.mts — 閒聊的節奏帳本（rhythm.ts）。
//
// 要守住的是六六要的那個節奏：話說完整可以連超三則，之後收著說把帳凹回來；
// 嚴肅的事不收；隔一陣子沒聊，帳歸零。
//
// 跑法：node dev/rhythm-test.mts

import { openBalance, modeOf, capFor, settle, isSerious, rhythmHint } from "../supabase/functions/_shared/rhythm.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
};
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`得到 ${JSON.stringify(a)}，應為 ${JSON.stringify(b)}`); };
const T = 180;

t("新帳充裕，上限 2.5T", () => { eq(modeOf(0, T), "free"); eq(capFor("free", T), 450); });

t("連說三則長話仍說得完，第四則起收斂", () => {
  let b = 0; const modes: string[] = [];
  for (let i = 0; i < 5; i++) {
    const m = modeOf(b, T); modes.push(m);
    b = settle(b, T, Math.min(capFor(m, T), 2 * T));   // 每則都想說 2T
  }
  eq(modes.slice(0, 3).includes("tight"), false);
  eq(modes.includes("tight"), true);
});

t("收斂後短答把帳凹回來", () => {
  let b = -3 * T; let n = 0;
  while (modeOf(b, T) !== "free" && n < 20) { b = settle(b, T, 0.4 * T); n++; }
  eq(modeOf(b, T), "free");
  if (n > 6) throw new Error(`凹回來花了 ${n} 則，太久`);
});

t("存款有上限：一路短答存不出暴長的額度", () => {
  let b = 0; for (let i = 0; i < 50; i++) b = settle(b, T, 10);
  eq(b, T);
});

t("欠款有底", () => { eq(settle(-4 * T, T, 10 * T), -4 * T); });

t("長期平均不超過 T（成本不變）", () => {
  let b = 0, sum = 0; const N = 300;
  for (let i = 0; i < N; i++) {
    const m = modeOf(b, T);
    const want = i % 5 === 0 ? 3 * T : m === "tight" ? 0.5 * T : T;   // 偶爾長話，其餘照常
    const out = Math.min(capFor(m, T), want);
    sum += out; b = settle(b, T, out);
  }
  if (sum / N > T * 1.05) throw new Error(`平均 ${Math.round(sum / N)}`);
});

t("嚴肅的事：收斂模式也給平常上限、不叫角色收", () => {
  eq(capFor("tight", T, true), 270);
  eq(rhythmHint("tight", "daoshi_m", true), "");
  eq(isSerious("老師說童童快不行了，明天檢查，我想哭"), true);
  eq(isSerious("今天晚餐吃什麼好"), false);
});

t("隔三小時帳歸零；讀不到當 0", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  eq(openBalance(-500, "2026-09-30T11:00:00Z", now), -500);
  eq(openBalance(-500, "2026-09-30T08:00:00Z", now), 0);
  eq(openBalance(null, null, now), 0);
});

t("平常模式不加提示；收斂帶角色口吻", () => {
  eq(rhythmHint("normal", "daoshi_m"), "");
  if (!rhythmHint("tight", "lingshou").includes("看他一眼")) throw new Error("觀喵收斂沒帶口吻");
});

t("充裕時不提示（說多長由角色決定）", () => { eq(rhythmHint("free", "daoshi_m"), ""); });

console.log(`\n${pass} 過、${fail} 敗`);
if (fail) process.exit(1);
