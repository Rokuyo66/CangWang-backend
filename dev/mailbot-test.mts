// dev/mailbot-test.mts — 信箱管家的判斷（mailbot.ts）。
//
// 要守住的只有一條：寧可多問一封，不可錯刪一封。
//   ・帳單、驗證碼、建案這類信，AI 再有把握也不准自動刪
//   ・AI 說刪但不是廣告型（沒退訂標頭、不在促銷分類）的信，改問
//   ・觀主的規則最大；但「主旨含」這種粗規則碰到守門字要改問
//   ・模型沒回或回壞了，那封這輪不處理（回 null），不可默默當成 keep 記掉
//
// 跑法：node dev/mailbot-test.mts

import {
  parseFrom, matchRule, decide, parseClassify, parseMbCallback, mbCallback,
  digestText, weeklyText, delta, guardHit, type Rule, type Meta,
} from "../supabase/functions/_shared/mailbot.ts";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + ((e as Error)?.message ?? e)); }
};
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`得到 ${JSON.stringify(a)}，應為 ${JSON.stringify(b)}`); };

const promo: Meta = { from: "蝦皮購物 <news@mail.shopee.tw>", subject: "雙11 全站免運", snippet: "限時優惠", labels: ["INBOX", "CATEGORY_PROMOTIONS"], listUnsubscribe: true };
const personal: Meta = { from: "Amy <amy@gmail.com>", subject: "週末要不要吃飯", snippet: "好久不見", labels: ["INBOX", "CATEGORY_PERSONAL"], listUnsubscribe: false };
const bill: Meta = { from: "國泰世華 <service@cathaybk.com.tw>", subject: "十月信用卡帳單", snippet: "本期應繳", labels: ["INBOX", "CATEGORY_PROMOTIONS"], listUnsubscribe: true };
const rules: Rule[] = [
  { id: 1, kind: "domain", pattern: "shopee.tw", action: "trash" },
  { id: 2, kind: "sender", pattern: "vip@mail.shopee.tw", action: "report" },
  { id: 3, kind: "subject", pattern: "優惠", action: "trash" },
];

t("parseFrom 拆出名字、小寫 email、網域", () => {
  eq(parseFrom('"王小明" <Foo@Bar.COM>'), { email: "foo@bar.com", name: "王小明", domain: "bar.com" });
  eq(parseFrom("solo@x.io").name, "solo@x.io");
});

t("網域規則涵蓋子網域；寄件人規則比網域規則優先", () => {
  eq(matchRule(promo, rules)?.id, 1);
  eq(matchRule({ ...promo, from: "VIP <vip@mail.shopee.tw>" }, rules)?.id, 2);
});

t("網域規則不會誤套到長得像的網域", () => {
  eq(matchRule({ ...personal, from: "x <a@notshopee.tw>", subject: "hi" }, rules), null);
});

t("同一層 report 勝過 trash", () => {
  const r: Rule[] = [{ id: 9, kind: "subject", pattern: "帳單", action: "trash" }, { id: 8, kind: "subject", pattern: "信用卡", action: "report" }];
  eq(matchRule(bill, r)?.id, 8);
});

t("守門字：帳單即使 AI 高信心說刪，也只能問", () => {
  eq(guardHit(bill), true);
  eq(decide(bill, null, { v: "trash", c: 0.99, why: "廣告", sum: "" })?.decision, "ask");
});

t("主旨規則要刪、但信有守門字 → 改問", () => {
  const otp: Meta = { ...promo, subject: "優惠碼與驗證碼", from: "x <a@b.com>" };
  const d = decide(otp, matchRule(otp, rules), null);
  eq([d?.decision, d?.source], ["ask", "guard"]);
});

t("寄件人／網域規則是觀主明說的，照做", () => {
  eq(decide(promo, rules[0], null)?.decision, "trash");
});

t("AI 高信心＋廣告型 → 自動刪", () => {
  eq(decide(promo, null, { v: "trash", c: 0.9, why: "促銷", sum: "" })?.decision, "trash");
});

t("AI 說刪但信心不足 → 問", () => {
  eq(decide(promo, null, { v: "trash", c: 0.6, why: "", sum: "" })?.decision, "ask");
});

t("AI 說刪、高信心，但不是廣告型（真人信）→ 問", () => {
  eq(decide(personal, null, { v: "trash", c: 0.95, why: "", sum: "" })?.decision, "ask");
});

t("模型沒回 → null（這輪不處理）", () => {
  eq(decide(personal, null, null), null);
});

t("parseClassify 容錯：圍籬、越界、壞值都擋掉", () => {
  const out = parseClassify('```json\n[{"i":0,"v":"report","c":0.8,"why":"x","sum":"y"},{"i":5,"v":"trash"},{"i":1,"v":"nuke"},{"i":2,"v":"keep","c":7}]\n```', 3);
  eq(out[0]?.v, "report"); eq(out[1], null); eq(out[2]?.c, 1);
  eq(parseClassify("抱歉", 2), [null, null]);
});

t("callback_data 來回一致、在 64 bytes 內、拒絕雜訊", () => {
  const s = mbCallback("D", 123456789012);
  eq(parseMbCallback(s), { op: "D", id: 123456789012 });
  if (new TextEncoder().encode(s).length > 64) throw new Error("超過 64 bytes");
  eq(parseMbCallback("mb:x:1"), null);
  eq(parseMbCallback("mh:p:1"), null);
});

t("沒事就不發匯報；有事 HTML 有轉義", () => {
  eq(digestText([], { trashed: 0, kept: 3, asked: 0, skipped: 0, trashedSenders: [] }), "");
  const s = digestText([{ from: "A<b> <a@b.c>", subject: "x < y", sum: "" }], { trashed: 2, kept: 0, asked: 0, skipped: 0, trashedSenders: ["S"] });
  if (!s.includes("x &lt; y") || s.includes("x < y")) throw new Error("主旨沒轉義");
  if (!s.includes("已刪 2 封")) throw new Error("沒報刪除數");
});

t("delta：新／持平／升降", () => {
  eq(delta(5, 0), "（新）"); eq(delta(0, 0), ""); eq(delta(10, 10), "（持平）");
  eq(delta(12, 10), "（▲20%）"); eq(delta(5, 10), "（▼50%）");
});

t("週報算得出留存與毛利，空資料不炸", () => {
  const s = weeklyText({
    from: "2026-10-05", to: "2026-10-11",
    cur: { new_users: 12, active_users: 40, casts: 100, casts_web: 30, followups: 20, chats: 300, verdicts: 4, verdict_hit: 3, lingshi_spent: 500, revenue_twd: 900, payments: 3, ai_twd: 400 },
    prv: { active_users: 20 }, retained: 10,
    casts_by_char: { daoshi_f: 60, lingshou: 40 }, casts_by_cat: { 感情: 50 },
    by_day: { "2026-10-06": 20, "2026-10-07": 25 },
    mail: { trashed: 50, reported: 4, open: 1, rules: 6 },
  });
  for (const k of ["50%（10/20）", "毛利 NT$ <b>500</b>", "師妹 60", "10-07", "準 75%"]) if (!s.includes(k)) throw new Error(`少了「${k}」`);
  weeklyText({ from: "", to: "", cur: {}, prv: {}, retained: 0, casts_by_char: {}, casts_by_cat: {}, by_day: {}, mail: { trashed: 0, reported: 0, open: 0, rules: 0 } });
});

setTimeout(() => {
  console.log(`\n${pass} 過、${fail} 敗`);
  if (fail) process.exit(1);
});
