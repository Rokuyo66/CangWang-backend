// dev/case-schema-test.mts — validator 的反向測試。
//
// 「驗證通過」只有在驗證器抓得到錯的前提下才是證據。
// 這裡刻意把案件檔改壞，確認每一種壞法都被抓到；抓不到就是驗證器有洞。
//
// 跑法：node dev/case-schema-test.mts

import { validateCase, type CaseFile } from "../supabase/functions/_shared/case-schema.ts";
import { HUANGCUN } from "../supabase/functions/_shared/cases/huangcun.ts";

const clone = (): CaseFile => structuredClone(HUANGCUN);

type Case = { name: string; broken: () => CaseFile; expect: RegExp };

const CASES: Case[] = [
  {
    name: "缺一區（地圖只剩五區）",
    broken: () => { const c = clone(); c.regions = c.regions.filter((r) => r.pos !== 3); return c; },
    expect: /缺第 3 區/,
  },
  {
    name: "兩區搶同一爻位",
    broken: () => { const c = clone(); c.regions[2].pos = 4; return c; },
    expect: /第 4 區重複|缺第 3 區/,
  },
  {
    name: "用神取法不合法",
    broken: () => { const c = clone(); c.useQin = "六獸"; return c; },
    expect: /useQin「六獸」不合法/,
  },
  {
    name: "沒寫客觀真相",
    broken: () => { const c = clone(); c.truth = "   "; return c; },
    expect: /缺 truth/,
  },
  {
    name: "物件指向不存在的線索",
    broken: () => { const c = clone(); c.regions[0].objects[0].clue = "c_nope"; return c; },
    expect: /指向不存在的線索 c_nope/,
  },
  {
    name: "孤兒線索（沒有任何取得途徑）",
    broken: () => {
      const c = clone();
      c.clues.push({ id: "c_orphan", name: "無主線索", region: 2, text: "沒人拿得到。" });
      return c;
    },
    expect: /c_orphan.*無任何取得途徑/,
  },
  {
    name: "前置線索成環（玩家永遠解不開）",
    broken: () => {
      const c = clone();
      c.clues.find((x) => x.id === "c_stele_mark")!.requires = ["c_cellar"];
      return c;
    },
    expect: /線索依賴成環/,
  },
  {
    name: "道具被鎖在需要它自己才能開的門後（自鎖死結）",
    broken: () => {
      const c = clone();
      // 短撬出自第 2 區農具堆，把那個物件也設成需要短撬才能翻
      c.regions.find((r) => r.pos === 2)!.objects.find((o) => o.id === "o_tools")!.needsItem = "c_pry";
      return c;
    },
    expect: /線索依賴成環.*c_pry/,
  },
  {
    name: "needsItem 指向的是 knowledge 而非 item",
    broken: () => {
      const c = clone();
      c.regions.find((r) => r.pos === 6)!.objects.find((o) => o.id === "o_pit")!.needsItem = "c_ash";
      return c;
    },
    expect: /知識撬不開門/,
  },
  {
    name: "needsItem 指向不存在的道具",
    broken: () => {
      const c = clone();
      c.regions.find((r) => r.pos === 6)!.objects.find((o) => o.id === "o_pit")!.needsItem = "c_ghost";
      return c;
    },
    expect: /需要不存在的道具 c_ghost/,
  },
  {
    name: "NPC 反應指向不存在的線索",
    broken: () => { const c = clone(); c.npcs[0].reactsTo = ["c_ghost"]; return c; },
    expect: /reactsTo 指向不存在的線索 c_ghost/,
  },
  {
    name: "同行角色能拿到自己搜不到的區的線索",
    broken: () => {
      const c = clone();
      c.companions[0].clues.push("c_well_cloth"); // 第 1 區，但師兄只搜 4/5/6
      return c;
    },
    expect: /但該線索在第 1 區而角色搜索不到那裡/,
  },
  {
    name: "同行角色 id 不是三角色之一",
    broken: () => { const c = clone(); c.companions[0].id = "shixiong"; return c; },
    expect: /同行角色 id「shixiong」不合法/,
  },
  {
    name: "線索區號越界",
    broken: () => { const c = clone(); c.clues[0].region = 7; return c; },
    expect: /region 越界：7/,
  },
  {
    name: "onKey 用了不存在的代價名",
    broken: () => {
      const c = clone();
      (c.regions[0].onKey as Record<string, string>).veryHard = "……";
      return c;
    },
    expect: /onKey 有未知代價「veryHard」/,
  },
  {
    name: "進案時辰越界",
    broken: () => { const c = clone(); c.entryHour = 25; return c; },
    expect: /entryHour 須為 0\.\.23/,
  },
  {
    name: "線索 id 重複",
    broken: () => {
      const c = clone();
      c.clues.push({ ...c.clues[0], name: "撞號的線索" });
      return c;
    },
    expect: /線索 id 重複/,
  },
];

let pass = 0, fail = 0;

// 先確認乾淨的案件檔是乾淨的——否則下面每一項都會「意外通過」
const clean = validateCase(HUANGCUN);
if (clean.length) {
  console.log(`❌ 基準案件檔本身就不乾淨，反向測試無意義：\n  ${clean.join("\n  ")}`);
  process.exit(1);
}
console.log("✅ 基準：荒村借宿結構乾淨\n");

for (const c of CASES) {
  const errs = validateCase(c.broken());
  const hit = errs.some((e) => c.expect.test(e));
  if (hit) { pass++; console.log(`  ✅ ${c.name}`); }
  else {
    fail++;
    console.log(`  ❌ ${c.name}\n       期望符合 ${c.expect}\n       實際：${errs.length ? errs.join(" ／ ") : "（驗證器什麼都沒抓到）"}`);
  }
}

console.log(`\n${pass} 過 / ${fail} 敗`);
if (fail) process.exit(1);
