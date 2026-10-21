// dev/memkind-test.mts — 記憶分類與時效（memkind.ts）＋起居注解析（days.ts）。
//
// 原案（六六 2026-09-30）：一則記憶混著「台股大跌、情緒波動」「對男性普遍負面」「師妹判斷……」，
// 過了很久角色還當他在氣頭上；日子戳的是彙整那天，不是事情那天。
//
// 跑法：node dev/memkind-test.mts

(globalThis as Record<string, unknown>).Deno ??= { env: { get: () => undefined } };
const { kindOf, isDormant, arrangeMemories, parseMemoryLines, datedDialog, condenseCount } = await import("../supabase/functions/_shared/memkind.ts");
const { parseDay, twDay } = await import("../supabase/functions/_shared/days.ts");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) pass++; else { fail++; console.log("✗", n); } };
const now = Date.parse("2026-10-20T12:00:00+08:00");
const age = (iso?: string) => iso ? `〔${iso.slice(5, 10)}〕` : "";

// 分類輸出解析
const out = parseMemoryLines("事件｜9/28｜台股大跌三千，他虧了不少\n狀態｜9/28｜那天壓力很大，隔天股票漲回來才平復\n其人｜-｜自稱六六，做遊戲 UI", "2026-09-30T10:00:00Z");
ok("解析出三則", out.length === 3);
ok("事件帶發生那天", out[0].kind === "event" && out[0].happened_on === "2026-09-28");
ok("狀態帶發生那天", out[1].kind === "state" && out[1].happened_on === "2026-09-28");
ok("其人不綁日子", out[2].kind === "trait" && out[2].happened_on === null);
ok("跨年：12/31 在 1/2 的批次裡是去年", parseMemoryLines("事件|12/31|跨年", "2027-01-02T04:00:00Z")[0].happened_on === "2026-12-31");
ok("認不出格式照存", parseMemoryLines("他說他養了一隻貓", "2026-09-30T10:00:00Z")[0].kind === null);
ok("無新記憶 → 空", parseMemoryLines("無新記憶", "2026-09-30T10:00:00Z").length === 0);
ok("最多四則", parseMemoryLines("事件|1/1|a\n事件|1/2|b\n事件|1/3|c\n事件|1/4|d\n事件|1/5|e", "2026-09-30T10:00:00Z").length === 4);

// 舊資料判類：截圖那一則會被當狀態
const old = { body: "護道人最近因為台股大跌三千承受巨大壓力，情緒波動大，後來股票漲回來了才平復", created_at: "2026-09-30T08:00:00Z" };
ok("舊資料含情緒 → 狀態", kindOf(old) === "state");
ok("舊資料一般事 → 事件", kindOf({ body: "他養了一隻叫童童的貓" }) === "event");

// 時效：狀態七天後不注入，釘選例外；事件與其人不淡
ok("狀態 20 天前淡去", isDormant(old, now));
ok("狀態釘選不淡", !isDormant({ ...old, pinned_at: "2026-10-01T00:00:00Z" }, now));
ok("狀態 3 天內還在", !isDormant({ body: "那天很累", kind: "state", happened_on: "2026-10-18" }, now));
ok("事件不淡", !isDormant({ body: "台股大跌", kind: "event", happened_on: "2026-09-01" }, now));

const text = arrangeMemories([
  old,
  { body: "自稱六六", kind: "trait" },
  { body: "台股大跌三千", kind: "event", happened_on: "2026-09-28" },
  { body: "那天沒睡好", kind: "state", happened_on: "2026-10-19" },
], age, now);
ok("分段：其人", text.includes("【他這個人】\n・自稱六六"));
ok("分段：事件帶那天", text.includes("〔09-28〕台股大跌三千"));
ok("新鮮的狀態還在", text.includes("那天沒睡好"));
ok("過時的狀態不注入", !text.includes("情緒波動"));

// 對話逐日標
const dlg = datedDialog([
  { role: "user", body: "a", created_at: "2026-09-27T15:00:00Z" },   // 台北 9/27 23:00
  { role: "user", body: "b", created_at: "2026-09-27T17:00:00Z" },   // 台北 9/28 01:00
], (m) => m.body);
ok("逐日標台北日期", dlg === "〔9/27〕\na\n〔9/28〕\nb");

// 何時形成回憶：以一場對話為單位
const T0 = Date.parse("2026-10-01T10:00:00+08:00");
const series = (n: number, start: number, stepMin = 2) => Array.from({ length: n }, (_, i) => ({ created_at: new Date(start + i * stepMin * 60_000).toISOString() }));
const live = series(60, T0);                                   // 一場還在聊的 60 則
ok("一場還在聊、沒超過上限：不收", condenseCount(live, T0 + 60 * 2 * 60_000) === 0);
const twoSessions = [...series(30, T0), ...series(10, T0 + 6 * 3600_000)];   // 上一場 30 則，這一場 10 則
ok("上一場結束，但扣掉最近 32 則只剩 8 則：先不收，免得又是一則短回憶", condenseCount(twoSessions, T0 + 6 * 3600_000 + 20 * 60_000) === 0);
const bigOld = [...series(50, T0), ...series(10, T0 + 6 * 3600_000)];
ok("上一場 50 則：收到只剩最近 32 則", condenseCount(bigOld, T0 + 6 * 3600_000 + 20 * 60_000) === 28);
const ended = series(70, T0);
ok("最後一場也結束了：一併收", condenseCount(ended, T0 + 70 * 2 * 60_000 + 4 * 3600_000) === 38);
const small = [...series(10, T0), ...series(30, T0 + 8 * 86400_000)];
ok("零星幾句放了一週：照收", condenseCount(small, T0 + 8 * 86400_000 + 70 * 60_000) === 8);
ok("一場聊太長（過 112 則）：先收舊的", condenseCount(series(120, T0), T0 + 120 * 2 * 60_000) === 88);

// 起居注解析
const day = parseDay("【大師兄】\n・後院的木樁裂了，他削了一根新的\n・師傅又踩了卦紙\n【師妹】\n・醃了一罈蘿蔔\n【觀貓】\n・在屋脊上睡了一下午");
ok("三人都有", !!day.daoshi_m && !!day.daoshi_f && !!day.lingshou);
ok("同一人多件合成一段", day.daoshi_m === "後院的木樁裂了，他削了一根新的；師傅又踩了卦紙");
ok("觀貓也認成觀喵", day.lingshou === "在屋脊上睡了一下午");
ok("台北日期", twDay(Date.parse("2026-09-30T17:00:00Z")) === "2026-10-01");

console.log(`\n${pass} 過 / ${fail} 敗`);
if (fail) process.exit(1);
