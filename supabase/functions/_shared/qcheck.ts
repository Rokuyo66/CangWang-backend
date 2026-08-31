// _shared/qcheck.ts — 問句的確定性檢查（零依賴、零 I/O，可單獨測）
//
// 【為什麼獨立成檔】這幾條規則有三個地方要用：qrefine 的擬題師、chat 的三段式擬題、
//   還有前端 part2.html 的 needsRefine。擺在 qrefine.ts 會讓 chat.ts ↔ qrefine.ts
//   互相 import 成環（qrefine 需要 chat 的 s2t），也沒辦法在 node 底下單獨跑測試。
//
// 【二選一為什麼要攔】一卦只取一個用神、只答那一個用神的成敗，答不出「A 和 B 哪個好」。
//   「我該接受新職缺offer還是留在現職？」這種句子送進去起卦，用神當場就取不出來，
//   卦排得再準也是錯題。規則裡早就寫了，但規則靠模型自律；這一檔靠攔。
//
// ⚠ 誤判方向是刻意的：寧可多攔（頂多多提醒一句、或不擬），不可放一句二選一出去。
// ⚠ 前端 part2.html 的 needsRefine 是同一套規則的 JS 版，改這裡務必同步改那裡。

/** 二選一的毛病文案：前端與 TG 都直接呈給用戶看，所以要把「先問哪一個」講清楚。 */
export const EITHER_OR_ISSUE =
  "這是二選一，一卦只答得了其中一條路——先挑你最想成的那一條問，另一條等這卦有結果之後再另占";

const EITHER_OR: RegExp[] = [
  // A 還是 B／A 或是 B：左右都要有實字，「我還是想問」這種語氣詞才不會被算進來
  /[^\s，。！？、,.!?]{2,}(還是|或是|抑或)[^\s，。！？、,.!?]{2,}/,
  /二選一|兩者(擇一|選一)|擇一/,
  /(該|要|想|得)(選|挑)(哪|那)/,
  /(哪|那)一?(個|條|邊|方|家|間)(比較|更|較)?[好對順佳強優適劃划]/,
  /(比較|更)(好|順|適合|划算|劃算|有利|吃香)/,
  /(哪|誰)(個|一個)?(比較|更)/,
  /[Vv][Ss]\.?/,
];

/** 這句是不是「A 還是 B」式的二選一（含比較級）。是的話，卦取不了用神，一律不可擬成一句。 */
export function isEitherOr(qRaw: string): boolean {
  const q = String(qRaw ?? "").trim();
  if (!q) return false;
  return EITHER_OR.some((re) => re.test(q));
}

/** 擬題候選過濾：二選一的一律丟掉。回傳留下的與被攔下的（被攔的要進 log，才看得出模型多常犯）。 */
export function filterRewrites(raw: string[]): { kept: string[]; blocked: string[] } {
  const kept: string[] = [], blocked: string[] = [];
  for (const r of raw) (isEitherOr(r) ? blocked : kept).push(r);
  return { kept, blocked };
}

/* ---------- 本地預檢（零延遲零成本；命中才值得呼叫模型） ----------
   缺時限「不」列入觸發條件——多數人本來就不寫時限，每卦都攔會變成嘮叨；改寫時再幫他補上。 */
export function preflight(qRaw: string): { need: boolean; issues: string[] } {
  const q = String(qRaw ?? "").trim();
  const issues: string[] = [];
  if (!q) return { need: false, issues };
  if (q.length < 6) issues.push("太短，看不出你問的是哪件事");
  if (/(還有|另外|順便|以及|同時|順帶)/.test(q) || (q.match(/[?？]/g) ?? []).length > 1) issues.push("一次問了兩件事");
  // 二選一：舊版完全漏掉，這種問句是靜默放行的——正是「接受offer還是留在現職」跑出去的原因
  if (isEitherOr(q)) issues.push(EITHER_OR_ISSUE);
  if (/(怎麼辦|該怎麼|怎樣才|怎麼樣才|為什麼|為何|如何是好|好不好|如何)/.test(q)) issues.push("是開放題，日後無從印證準不準");
  if (/(如果|假如|要是|萬一)/.test(q)) issues.push("帶了假設，卦問不了還沒發生的假設");
  if (/(好煩|好累|崩潰|焦慮|難過|想哭|不知道該|好迷茫|迷惘|心很亂)/.test(q)) issues.push("多是心情，還沒落到具體的事");
  if (/(人生|一輩子|這輩子|未來)/.test(q) && q.length < 14) issues.push("問得太大，卦應不了一輩子");
  return { need: issues.length > 0, issues };
}
