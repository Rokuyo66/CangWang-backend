// dev/chat-loop-test.mts — 時辰、新一場只帶上一場尾巴、繞圈偵測（六六 2026-10-24）。
//
// 回報：凌晨五點還在聊，角色毫無知覺；刪了回憶，師妹還是卡在質疑他的位置、師兄還是一直問肚子痛。
//
// 跑法：node dev/chat-loop-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { trimPastSessions, loopWords, loopHint, timeSense } = await import("../supabase/functions/_shared/chat.ts");
const { tianshiLine, shichenOf } = await import("../supabase/functions/_shared/tianshi.ts");

let p = 0, f = 0; const ok = (n: string, c: boolean) => { if (c) p++; else { f++; console.log("✗", n); } };
const tw = (s: string) => Date.parse(`2026-10-24T${s}:00+08:00`);

// ── 時辰 ──
ok("五點十分是卯初、約清晨五點", shichenOf(tw("05:10")).text.startsWith("卯初（約清晨五點）"));
ok("六點半是卯正", shichenOf(tw("06:40")).text.startsWith("卯正（約清晨六點半）"));
ok("十一點半是子初", shichenOf(tw("23:30")).text.startsWith("子初"));
ok("半夜十二點是子正", shichenOf(tw("00:20")).text.startsWith("子正（約半夜十二點）"));
ok("中午是午正", shichenOf(tw("12:05")).text.startsWith("午正"));
ok("天時帶時辰", tianshiLine(tw("05:10")).includes("【此刻時辰】卯初"));
ok("三人都有時辰覺察", ["daoshi_m", "daoshi_f", "lingshou"].every((c) => timeSense(c).includes("【時辰的覺察】")));

// ── 新的一場只帶上一場的尾巴 ──
const now = tw("20:00");
const at = (h: number) => new Date(now - h * 3600_000).toISOString();
const row = (role: string, h: number, body = "x") => ({ role, body, created_at: at(h) });
const old = [row("user", 30), row("assistant", 30), row("user", 29.9), row("assistant", 29.9), row("user", 29.8), row("assistant", 29.8), row("user", 29.7), row("assistant", 29.7)];
const cur = [row("user", 0.2), row("assistant", 0.2), row("user", 0.1), row("assistant", 0.1)];
ok("這一場還在：上一場只留 4 則＋這一場全帶", trimPastSessions([...old, ...cur], now).length === 8);
ok("新開一場：整段都是上一場，只留 4 則", trimPastSessions(old, now).length === 4);
ok("只有這一場：一則不砍", trimPastSessions(cur, now).length === 4);
ok("留下的從他說的那句起", trimPastSessions(old.slice(0, 7), now)[0].role === "user");
ok("空的不出錯", trimPastSessions([], now).length === 0);

// ── 繞圈 ──
const loop = [
  { role: "user", body: "我今天去看了房子" },
  { role: "assistant", body: "「肚子還疼嗎？房子的事不急。」" },
  { role: "user", body: "還好啦，那個建案在航空城" },
  { role: "assistant", body: "「航空城啊……你肚子好些了沒？」" },
  { role: "user", body: "我在想要不要簽約" },
  { role: "assistant", body: "＊他把茶盞推過去＊「先顧好肚子，簽約的事慢慢想。」" },
];
ok("師兄一直問肚子：抓得到", loopWords(loop, "你覺得價錢合理嗎").includes("肚子"));
ok("他自己這句提了肚子：不算繞圈", !loopWords(loop, "肚子早就不痛了").includes("肚子"));
ok("他前一句提過的不算（簽約）", !loopWords(loop, "價錢呢").some((w) => w.includes("簽約")));
ok("不到三則不判", loopWords(loop.slice(0, 4), "嗯").length === 0);
ok("道號排除", !loopWords(loop, "嗯", "肚子").length);
ok("提示句帶詞", loopHint(loop, "價錢呢").includes("「肚子」"));
ok("沒繞圈就沒提示", loopHint([
  { role: "user", body: "早" }, { role: "assistant", body: "「早，吃了嗎？」" },
  { role: "user", body: "吃了" }, { role: "assistant", body: "「那就好。」" },
  { role: "user", body: "要出門" }, { role: "assistant", body: "「路上小心。」" },
], "嗯") === "");

console.log(`\n${p} 過 / ${f} 敗`); if (f) process.exit(1);
