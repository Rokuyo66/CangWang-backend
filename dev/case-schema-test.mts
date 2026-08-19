// dev/case-schema-test.mts — validator 的反向測試。
//
// 「驗證通過」只有在驗證器抓得到錯的前提下才是證據。
// 這裡刻意把案件檔改壞，確認每一種壞法都被抓到；抓不到就是驗證器有洞。
//
// 跑法：node dev/case-schema-test.mts

import { validateCase, type CaseFile } from "../supabase/functions/_shared/case-schema.ts";
import { HUANGCUN } from "../supabase/functions/_shared/cases/huangcun.ts";

const clone = (): CaseFile => structuredClone(HUANGCUN);

type Case = { name: string; broken: () => CaseFile; expect: RegExp; negate?: boolean };

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
    name: "NPC 台詞給的線索不存在",
    broken: () => { const c = clone(); c.npcs[0].says.push({ text: "……", clue: "c_ghost" }); return c; },
    expect: /指向不存在的線索 c_ghost/,
  },
  {
    name: "NPC 台詞的 needs 指向不存在的線索",
    broken: () => { const c = clone(); c.npcs[0].says.push({ text: "……", needs: ["c_ghost"] }); return c; },
    expect: /needs 指向不存在的線索 c_ghost/,
  },
  {
    name: "NPC 要先有這條線索才肯說出這條線索（自己擋自己）",
    broken: () => {
      const c = clone();
      c.npcs[0].says.push({ text: "……", clue: "c_ash", needs: ["c_ash"] });
      return c;
    },
    expect: /自己擋自己/,
  },
  {
    name: "NPC 開不了口（says 空）",
    broken: () => { const c = clone(); c.npcs[0].says = []; return c; },
    expect: /沒有任何 says/,
  },
  {
    name: "口供互鎖：甲要證據才說，證據又只有乙在有甲的口供後才給",
    broken: () => {
      const c = clone();
      // 只留下互鎖的兩條路：先拔掉物件與同行角色這兩個旁路，
      // 否則師妹／觀喵照樣拿得到 c_well_cloth，那就不是死鎖（驗證器判對）。
      c.regions.find((r) => r.pos === 1)!.objects.find((o) => o.id === "o_well")!.clue = undefined;
      for (const comp of c.companions)
        comp.clues = comp.clues.filter((x) => x !== "c_well_cloth" && x !== "c_villager_lie");
      // n_widow 要先有 c_villager_lie 才說得出 c_well_cloth
      c.npcs.find((n) => n.id === "n_widow")!.says.push(
        { text: "……", clue: "c_well_cloth", needs: ["c_villager_lie"] });
      // 而 c_villager_lie 又要先有 c_well_cloth 才問得出來
      c.npcs.find((n) => n.id === "n_brother")!.says =
        [{ text: "……", clue: "c_villager_lie", needs: ["c_well_cloth"] }];
      return c;
    },
    expect: /線索依賴成環/,
  },
  {
    name: "旁路仍在時不該誤報死鎖（互鎖但同行角色拿得到）",
    broken: () => {
      const c = clone();
      c.regions.find((r) => r.pos === 1)!.objects.find((o) => o.id === "o_well")!.clue = undefined;
      c.npcs.find((n) => n.id === "n_widow")!.says.push(
        { text: "……", clue: "c_well_cloth", needs: ["c_villager_lie"] });
      c.npcs.find((n) => n.id === "n_brother")!.says =
        [{ text: "……", clue: "c_villager_lie", needs: ["c_well_cloth"] }];
      return c;  // 師妹／觀喵沒動，兩條線索都還拿得到
    },
    expect: /^(?!.*依賴成環).*$/,   // 期望「不報死鎖」——見下方 negate
    negate: true,
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
  // negate 是反向的反向：確認驗證器在旁路仍在時「不要」誤報死鎖。
  // 只驗死鎖這一類，其他無關的錯不影響判定。
  const hit = c.negate
    ? !errs.some((e) => /依賴成環/.test(e))
    : errs.some((e) => c.expect.test(e));
  if (hit) { pass++; console.log(`  ✅ ${c.name}`); }
  else {
    fail++;
    console.log(`  ❌ ${c.name}\n       期望${c.negate ? "不報死鎖" : "符合 " + c.expect}\n       實際：${errs.length ? errs.join(" ／ ") : "（驗證器什麼都沒抓到）"}`);
  }
}

console.log(`\n${pass} 過 / ${fail} 敗`);
if (fail) process.exit(1);
