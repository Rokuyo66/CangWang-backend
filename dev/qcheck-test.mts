// dev/qcheck-test.mts — 二選一攔截與本地預檢驗證。
//
// 基準案例即實際出問題的那一句：「我該接受新職缺offer還是留在現職？」
// 舊版 preflight 完全沒有二選一這條，這種問句是靜默放行的；擬題師也照樣把它擬出來。
// 一卦只取一個用神、只答那一個用神的成敗，這種句子起了卦也是錯題。
//
// 跑法：node dev/qcheck-test.mts

import {
  isEitherOr, filterRewrites, preflight, EITHER_OR_ISSUE,
} from "../supabase/functions/_shared/qcheck.ts";

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) { fail++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`);
};

console.log("\n── 一、實際出問題的那一句 ──");
const BAD = "我該接受新職缺offer還是留在現職？";
ok(isEitherOr(BAD), `判為二選一：「${BAD}」`);
ok(preflight(BAD).need, "本地預檢會攔下（舊版是靜默放行，一張卡都不出）");
ok(preflight(BAD).issues.includes(EITHER_OR_ISSUE), "毛病文案明講「先挑一條問，另一條之後再另占」");

console.log("\n── 二、其他二選一句式 ──");
for (const q of [
  "該留在現職還是跳槽？",
  "我要選A公司或是B公司？",
  "三個月內換工作跟留下來哪個比較好？",
  "接offer跟不接，該選哪個？",
  "留下來比較順還是走比較順？",
  "現職 vs 新工作，哪個有利？",
  "兩份工作擇一，哪一個更適合我？",
]) ok(isEitherOr(q), `判為二選一：「${q}」`);

console.log("\n── 三、單選項問句不可被誤攔 ──");
for (const q of [
  "三個月內接下這份新工作，能不能順利上手？",
  "三個月內留在現職，能不能有起色？",
  "年底前這筆尾款收得回來嗎？",
  "我與阿明這段感情，半年內能不能定下來？",
  "這個月能不能找到租屋處？",
  "下週的面試會不會過？",
]) ok(!isEitherOr(q), `未被誤攔：「${q}」`);

console.log("\n── 四、擬題候選過濾 ──");
{
  const raw = [
    "三個月內接下這份新工作，能不能順利上手？",
    "我該接受新offer還是留在現職？",   // 模型再犯，要被攔掉
    "三個月內留在現職，能不能有起色？",
  ];
  const { kept, blocked } = filterRewrites(raw);
  ok(kept.length === 2 && blocked.length === 1, `三條候選攔下一條（留 ${kept.length}、攔 ${blocked.length}）`);
  ok(blocked[0] === raw[1], "被攔的正是那條二選一");
  ok(kept.every((q) => !isEitherOr(q)), "留下的每一條都只問一條路");
}

console.log("\n── 五、預檢其餘規則沒被改壞 ──");
ok(!preflight("年底前這筆尾款收得回來嗎？").need, "合格問句仍靜默放行，不燒 token");
ok(preflight("我該怎麼辦？").need, "開放題仍攔");
ok(preflight("好累").need, "情緒句仍攔");
ok(preflight("").need === false, "空字串不攔");

console.log(`\n${fail ? `✗ ${fail} 項不過` : "✓ 全過"}`);
process.exit(fail ? 1 : 0);
