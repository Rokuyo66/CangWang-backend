// rhythm.ts — 閒聊的節奏帳本（六六 2026-09-30）
//
// 病灶：每一則都被「一到三句」「好感 +N 句」「max_tokens 180」框住，角色永遠在省句子，
// 說出來的是一串結論的連珠炮，沒有一句話是講完整的。
//
// 改法：長度不再逐則限制，改記總帳。每組（護道人×角色）一本帳：
//   每則結算  帳 += 目標均值 T − 這則實際輸出
// 話說完整了（超標）就欠帳，之後幾則收著說把帳凹回來。長期平均仍是 T，成本不變；
// 能欠多少有底（DEBT_FLOOR），所以最壞的超支也是算得出來的。
//
//   帳 ≥ −1T        充裕：想說完整就說完整（上限 2.5T）
//   −1T > 帳 > −3T  平常：不提示（上限 1.5T）
//   帳 ≤ −3T        收斂：提示角色收著說（上限 1.0T），短答把帳還回來
//
// 例：連說三則 2T 的長話 → 帳 −1T（仍充裕）→ −2T（平常）→ −2.5T → 第四則起收斂。
// 模型看不到數字，只看到角色此刻的狀態（「話說得夠多了」），節奏是性格的一部分。
//
// 例外：嚴肅的事（病、喪、官司、變故）與問卦探詢不進收斂——那時該說多少就說多少。
// 隔 GAP_MS 沒說話就歸零：新的一場對話不該一開口就是收斂模式。

export type RhythmMode = "free" | "normal" | "tight";

export const RHYTHM_GAP_MS = 3 * 3600_000;     // 與 chat.ts 的 GAP_MARK_MS 同值：隔三小時就是另一場
const SAVE_CAP = 1;       // 最多存 1T：一路短答不能存出一次暴長的額度
const DEBT_FLOOR = -4;    // 最多欠 4T：上限壓著本來就欠不到，這是保險
const FREE_LINE = -1;     // 帳 ≥ −1T：充裕
const TIGHT_LINE = -3;    // 帳 ≤ −3T：收斂

/** 帳隔太久就歸零；讀不到（null、舊 schema）當 0。 */
export function openBalance(balance: number | null | undefined, lastAt: string | null | undefined, now = Date.now()): number {
  const b = Number(balance);
  if (!Number.isFinite(b)) return 0;
  const t = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(t) || now - t >= RHYTHM_GAP_MS) return 0;
  return b;
}

export function modeOf(balance: number, target: number): RhythmMode {
  if (balance >= FREE_LINE * target) return "free";
  if (balance <= TIGHT_LINE * target) return "tight";
  return "normal";
}

/** 這一則的 max_tokens。嚴肅或探詢時至少給平常的量。 */
export function capFor(mode: RhythmMode, target: number, serious = false): number {
  const m = mode === "free" ? 2.5 : mode === "normal" || serious ? 1.5 : 1.0;
  return Math.round(target * m);
}

/** 結算：這則實際輸出 out 個 token 之後的新帳。 */
export function settle(balance: number, target: number, out: number): number {
  if (!Number.isFinite(out) || out <= 0) return balance;
  const b = balance + target - out;
  return Math.round(Math.max(DEBT_FLOOR * target, Math.min(SAVE_CAP * target, b)));
}

// 嚴肅的事：不進收斂。寧可多判（只是這則不收），不可漏判（人在說喪事，角色卻懶得多說）。
const SERIOUS_RE = /(病|醫|癌|腫瘤|開刀|手術|住院|檢查|過世|去世|走了|喪|葬|離婚|分手|官司|法院|被告|告我|失業|裁員|欠債|負債|出事|車禍|意外|懷孕|流產|自殺|想死|撐不下去|崩潰|好累|哭)/;
export const isSerious = (msg: string) => SERIOUS_RE.test(msg);

const TIGHT_VOICE: Record<string, string> = {
  daoshi_m: "像查完了只報結論。",
  daoshi_f: "笑著帶過，把話留一半讓他來問。",
  lingshou: "看他一眼、或一句話就夠。",
};

/** 放進 tail 的節奏提示。平常不提示；嚴肅時不叫角色收。 */
export function rhythmHint(mode: RhythmMode, characterId: string, serious = false): string {
  if (mode === "free") {
    return "\n【節奏】這一則若有話要說完整——一段往事、一個理由、一條想法的來龍去脈——就照你的思路把它說透；沒那麼多話就照常短說，不必湊長。";
  }
  if (mode === "tight" && !serious) {
    return `\n【節奏】你這陣子話說得多了，這一則收著說：只說最要緊的那件事，一兩句就停。${TIGHT_VOICE[characterId] ?? ""}`;
  }
  return "";
}
