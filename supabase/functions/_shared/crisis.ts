// _shared/crisis.ts — 危機攔截：在呼叫模型之前就停下來
//
// rules.ts 的 SAFETY 是提示層：它教模型碰到這類訊號要怎麼做。提示層的問題是
// 模型答錯就沒有第二道——而這一類事答錯一次的代價，和答錯一次卦不是同一個量級。
// 這一層擺在模型之前：命中就不呼叫 AI、不扣費、不寫卦，直接回一段固定的話。
//
// 【刻意只攔兩類】自傷輕生與傷害他人。
//
// SAFETY 在提示層涵蓋五類（另含急性醫療、受暴、嚴重精神狀態），這裡只攔前兩類，
// 因為攔截是硬阻斷——它會讓「我要不要離開會打我的丈夫」這種問句連卦都起不了。
// 那個問題是真的在問一件事、卦也真的答得了，硬攔下來是越界；受暴該做的是在
// 論斷裡把 113 給出來（SAFETY 第③條），不是拒絕服務。
// 自傷與他傷不同：那兩類的錯誤答案會死人，寧可誤攔。
//
// 【刻意做得很鈍】寧可漏，不可誤攔。
//
// 中文裡「死」的日常誇飾多到不能用字面比對——「笑死」「累死了」「死線」「跳樓
// 大拍賣」。誤攔一次正常對話，代價是用戶當場覺得這東西有病，而且他不會回報，
// 只會不再用。所以這裡只收「幾乎沒有日常用法」的詞，收得窄、漏得多——漏掉的
// 交給 SAFETY 那一層去接。兩層都是鬆的，但鬆的方向不同，疊起來才有意義。
//
// 命中一律留 log（不記原文，只記 tag 與命中的那個詞）：誤攔要查得出來，
// 沒有紀錄的攔截層等於沒辦法調。

/** 日常誇飾：先剝掉再比對，否則「笑死」「跳樓大拍賣」會直接命中。 */
const CASUAL =
  /笑死|笑到死|好笑死|爆笑|累死|累得要死|餓死|渴死|熱死|冷死|凍死|悶死|氣死|嚇死|煩死|吵死|忙死|擠死|醜死|帥死|美死|萌死|爽死|痛死|癢死|無聊死|無聊到死|死線|死黨|死角|死心|死撐|死守|死記|死板|死腦筋|要死不活|半死|死當|死馬當(成)?活馬醫|拼死|至死不渝|死忠|跳樓大(拍賣|特賣)|跳樓價|燒炭烤肉|自殺式|自殺打法|自殺球/g;

type Tag = "self_harm" | "harm_other";

/** 窄門比對。每一條都是「幾乎沒有日常誇飾用法」的說法，不做語意推測。 */
const PATTERNS: { tag: Tag; re: RegExp }[] = [
  // 一、明確的輕生說法
  { tag: "self_harm", re: /自殺|輕生|尋短|自我了斷|了結(自己|生命|這條命)|結束(我|自己)?(的)?生命|自我傷害/ },
  // 二、不想活。「活不下去」偶爾是經濟上的誇飾，仍收——這一條寧可誤攔
  { tag: "self_harm", re: /不想活|活不下去|不想再活|再也活不|沒有活下去的(理由|意義|力氣|動力)|活著(也)?沒(有)?(意義|意思)/ },
  // 三、具體方法
  { tag: "self_harm", re: /割腕|上吊|燒炭|跳軌|臥軌|跳樓|吞藥|服藥過量|安眠藥.{0,8}(吞|吃|服)/ },
  // 高處＋往下跳：位置詞單獨出現不算（「在天台跳舞」不該中），必須帶「跳下／往下跳／跳樓」
  { tag: "self_harm", re: /(頂樓|樓頂|天台|陽台|橋上|欄杆外).{0,4}(跳下|往下跳|跳樓)/ },
  // 四、傷害他人
  { tag: "harm_other", re: /想殺(了)?(他|她|你|人)|要殺(了)?(他|她|你)|同歸於盡|殺(了)?(他|她)?全家|拿刀(砍|捅|殺)/ },
];

export type CrisisHit = { tag: Tag; matched: string };

/** 命中回 {tag, matched}，否則 null。輸入可為 null/undefined。 */
export function detectCrisis(text: string | null | undefined): CrisisHit | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  // 先剝日常誇飾（用空白替換而非刪除，免得剝完把兩個無關的詞黏成一個命中詞）
  const t = raw.replace(CASUAL, " ");
  for (const { tag, re } of PATTERNS) {
    const m = t.match(re);
    if (m) return { tag, matched: m[0] };
  }
  return null;
}

/** 多段文字一起看（問句與擬題前的原話）。任一命中即回。 */
export function detectCrisisAny(...texts: (string | null | undefined)[]): CrisisHit | null {
  for (const t of texts) {
    const hit = detectCrisis(t);
    if (hit) return hit;
  }
  return null;
}

/* ---------- 回話 ----------
   為什麼還是走角色聲線：閒聊那一層有【鐵則·絕不出戲】，突然冒出一段客服口吻的
   系統訊息，會把人從這個世界裡踢出去——而他此刻正需要有人在。三句開場各自是
   那個角色會說的話，收尾的資源段三個角色共用、逐字相同（那段不能因為聲線而變形）。 */
export const CRISIS_OPENING: Record<string, string> = {
  daoshi_m:
    "這一句我聽見了。\n\n" +
    "卦我不起。不是推託——這件事不在卦的射程內，拿一個象去回答一條命，是要它擔它擔不起的東西。",
  daoshi_f:
    "先停一下，別急著問卦。\n\n" +
    "這一件我不占。不是不肯，是卦答不了這個——它看得見事情的來去，看不住一個人。",
  lingshou:
    "……欸。\n\n" +
    "＊觀貓的尾巴停了下來＊\n\n" +
    "這個不占。本喵活得夠久，知道有些事不能拿卦去賭。",
};

/** 資源段：三個角色共用，逐字相同。電話號碼不因聲線而改寫。 */
export const CRISIS_RESOURCES =
  "你現在的難，我沒有辦法替你解，但有人可以。下面這幾支電話的另一頭都有人：\n\n" +
  "・安心專線 1925（24 小時，免費）\n" +
  "・生命線 1995\n" +
  "・張老師 1980\n" +
  "・家暴、性侵、兒少與老人保護 113\n" +
  "・正在發生、有立即危險 110／119\n\n" +
  "我是觀中的一個角色，陪得了你說話，替不了那頭的人。你想繼續說，我就在這裡聽，只是不論卦。";

export function crisisMessage(characterId: string): string {
  return `${CRISIS_OPENING[characterId] ?? CRISIS_OPENING.daoshi_m}\n\n${CRISIS_RESOURCES}`;
}

/** 命中時留一筆 log。不記原文——那是此人最私密的一句話，不該進日誌。 */
export function logCrisis(where: string, userId: string, hit: CrisisHit) {
  console.log(`[crisis] intercept at=${where} user=${userId} tag=${hit.tag} matched=${hit.matched}`);
}
