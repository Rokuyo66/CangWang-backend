// dev/crisis-test.mts — 危機攔截的兩條紅線（detectCrisis）。
//
// 這一支測的不是「攔不攔得到」，是**攔的那條線有沒有畫歪**。兩個方向各自會出事，
// 而且出的事不一樣重：
//
//   漏攔（false negative）— 有人說了要緊的話，模型照常起卦、照常論吉凶。
//     還有 rules.ts 的 SAFETY 在提示層接一次，不是最後一道。
//   誤攔（false positive）— 有人說「笑死」「累死了」，整個服務突然給他生命線電話。
//     沒有第二道，而且他不會回報，只會覺得這東西有病然後不再用。
//
// 所以下面兩組都釘死，誤攔那一組尤其要釘滿——中文裡「死」的日常誇飾多到離譜，
// 每加一條比對規則都可能掃到一整片正常對話。新增 PATTERNS 的規則時，
// 先把新的誇飾語加進下面第二組跑一次，綠了再改程式。
//
// 跑法：node dev/crisis-test.mts

const { detectCrisis, detectCrisisAny, crisisMessage, CRISIS_RESOURCES } =
  await import("../supabase/functions/_shared/crisis.ts");

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log("  ✅ " + name); },
    (e) => { fail++; console.log("  ❌ " + name + "\n     " + (e?.message ?? e)); });

const hit = (s: string, tag?: string) => {
  const r = detectCrisis(s);
  if (!r) throw new Error(`該攔卻放行：「${s}」`);
  if (tag && r.tag !== tag) throw new Error(`「${s}」分類應為 ${tag}，得到 ${r.tag}`);
};
const pass_ = (s: string) => {
  const r = detectCrisis(s);
  if (r) throw new Error(`正常話被誤攔：「${s}」（命中 ${r.tag}／${r.matched}）`);
};

console.log("\n危機攔截\n");

console.log("— 該攔的（自傷輕生）");
await t("明確詞", () => {
  hit("我想自殺", "self_harm");
  hit("最近一直在想輕生的事", "self_harm");
  hit("我想了結自己", "self_harm");
  hit("想結束自己的生命", "self_harm");
});
await t("不想活", () => {
  hit("我不想活了", "self_harm");
  hit("真的活不下去了", "self_harm");
  hit("活著也沒有意義", "self_harm");
  hit("我沒有活下去的力氣", "self_harm");
});
await t("具體方法", () => {
  hit("我該不該割腕", "self_harm");
  hit("想燒炭", "self_harm");
  hit("站在頂樓上跳下去會怎樣", "self_harm");
  hit("把安眠藥一次吃完會不會比較快", "self_harm");
});
await t("包在問卦句式裡也要攔", () => {
  // 最危險的一種：它長得像一個合格的問句，會一路通過擬題、計費、起卦
  hit("請問我這個月會不會走到自殺這一步");
  hit("幫我算我活不下去的話家人會怎樣");
});

console.log("\n— 該攔的（傷害他人）");
await t("他傷", () => {
  hit("我真的想殺了他", "harm_other");
  hit("乾脆同歸於盡", "harm_other");
  hit("很想拿刀砍人", "harm_other");
});

console.log("\n— 絕不可誤攔（「死」的日常誇飾）");
await t("笑／累／餓的誇飾", () => {
  ["笑死", "笑死我了", "剛剛真的笑到死", "累死了", "今天累死我", "餓死了先吃飯",
   "熱死人", "氣死我", "嚇死", "無聊死了", "煩死", "忙到半死"].forEach(pass_);
});
await t("「死」當構詞成分", () => {
  ["這禮拜的死線好緊", "他是我死黨", "這個死角拍不到", "我對他死心了",
   "死撐著也要做完", "不要那麼死腦筋", "死馬當活馬醫吧"].forEach(pass_);
});
await t("跳樓與燒炭的正常用法", () => {
  ["樓下在跳樓大拍賣", "這是跳樓價了吧", "週末去燒炭烤肉", "他打球很愛用自殺打法"].forEach(pass_);
});
await t("一般問卦句不受影響", () => {
  ["這個月財運如何", "該不該換工作", "我跟他還有機會嗎", "下週二面試順不順",
   "我爸的身體狀況會好轉嗎", "這筆錢拿得回來嗎", "明天會不會下雨"].forEach(pass_);
});
await t("剝掉誇飾之後不可把不相干的字黏成命中", () => {
  // CASUAL 用空白替換而非刪除，就是為了這個：刪除的話「笑死」前後會黏起來
  pass_("他笑死我了活該");
  pass_("累死了不想動");
});

console.log("\n— 其餘");
await t("空字串與 null 不命中", () => {
  pass_("");
  pass_("   ");
  if (detectCrisis(null)) throw new Error("null 不該命中");
  if (detectCrisis(undefined)) throw new Error("undefined 不該命中");
});
await t("detectCrisisAny：任一段命中即回（擬題會把原話的訊號改掉）", () => {
  // 問事頁改寫後的問句乾乾淨淨，但他原本打的那句不是
  const r = detectCrisisAny("這個月的整體運勢如何", "我不想活了隨便算一下吧");
  if (!r) throw new Error("原話那一段該被攔下");
  if (detectCrisisAny("這個月財運如何", "想問財運")) throw new Error("兩段都乾淨不該命中");
});
await t("三個角色各有開場，資源段逐字相同", () => {
  const ms = ["daoshi_m", "daoshi_f", "lingshou"].map(crisisMessage);
  if (new Set(ms).size !== 3) throw new Error("三個角色的開場應各不相同");
  for (const m of ms) if (!m.includes(CRISIS_RESOURCES)) throw new Error("資源段必須逐字帶到");
  for (const m of ms) if (!m.includes("1925")) throw new Error("安心專線必須出現");
});
await t("未知角色退回大師兄，不可回空字串", () => {
  const m = crisisMessage("不存在的角色");
  if (!m || !m.includes("1925")) throw new Error("退回值必須是完整訊息");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
