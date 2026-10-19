// dev/mailbot-test.mts — 信箱管家的判斷（mailbot.ts）。
//
// 要守住的只有一條：寧可多問一封，不可錯刪一封。
//   ・帳單、驗證碼、建案這類信，AI 再有把握也不准自動刪
//   ・AI 說刪但不是廣告型（沒退訂標頭、不在促銷分類）的信，改問
//   ・觀主的規則最大；但「主旨含」這種粗規則碰到守門字要改問
//   ・模型沒回或回壞了，那封這輪不處理（回 null），不可默默當成 keep 記掉
//
// 跑法：node mailbot/dev/mailbot-test.mts

import {
  parseFrom, matchRule, decide, parseClassify, parseMbCallback, mbCallback,
  digestText, mailWeeklyText, guardHit, LABELS, SWEEP, sweepFor, fileOptions, fileButtons, fileText,
  isValidNewLabel, classifySys, type Rule, type Meta,
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

t("期限標籤：規則指定的優先於 AI 建議", () => {
  const r: Rule = { id: 5, kind: "sender", pattern: "amy@gmail.com", action: "report", label: "永久/房產" };
  eq(decide(personal, r, { v: "report", c: 1, why: "", sum: "", lb: "待辦" })?.label, "永久/房產");
  eq(decide(personal, null, { v: "keep", c: 1, why: "", sum: "", lb: "三月/帳單繳費" })?.label, "三月/帳單繳費");
});

t("期限標籤：只貼在留下來的信上，刪掉或待問的不貼", () => {
  eq(decide(promo, null, { v: "trash", c: 0.9, why: "", sum: "", lb: "待辦" })?.label, undefined);
  eq(decide(personal, null, { v: "ask", c: 0.5, why: "", sum: "", lb: "待辦" })?.label, undefined);
});

t("期限標籤：模型編出不存在的標籤一律丟掉", () => {
  const out = parseClassify('[{"i":0,"v":"keep","c":1,"lb":"五年/亂寫"},{"i":1,"v":"report","c":1,"lb":"五年/產品營運"}]', 2);
  eq(out[0]?.lb, undefined); eq(out[1]?.lb, "五年/產品營運");
  eq(decide(personal, { id: 1, kind: "sender", pattern: "amy@gmail.com", action: "keep", label: "沒這個" }, null)?.label, undefined);
});

t("到期清理只碰三月與五年，永久與待辦絕不在清單裡", () => {
  for (const s of SWEEP) {
    if (!/^(三月|五年)\//.test(s.label)) throw new Error(`清理清單混進 ${s.label}`);
    if (!(LABELS as readonly string[]).includes(s.label)) throw new Error(`${s.label} 不是現有標籤`);
    const want = s.label.startsWith("三月") ? "older_than:3m" : "older_than:5y";
    if (!s.q.includes(want)) throw new Error(`${s.label} 的期限寫錯：${s.q}`);
    if (!s.q.includes("label:" + s.label.replace("/", "-"))) throw new Error(`${s.label} 的搜尋語法寫錯：${s.q}`);
  }
  const swept = new Set(SWEEP.map((s) => s.label));
  for (const l of LABELS) if (/^(三月|五年)\//.test(l) && !swept.has(l)) throw new Error(`${l} 沒有到期清理`);
});

t("自動歸檔：規則指定了標籤 → 直接歸檔（觀主已經決定過）", () => {
  const r: Rule = { id: 1, kind: "sender", pattern: "amy@gmail.com", action: "report", label: "永久/重要內容" };
  eq(decide(personal, r, null)?.autoFile, true);
});

t("自動歸檔：AI 有把握的留存信才自動；要觀主看的、沒把握的、待辦，都推卡", () => {
  eq(decide(personal, null, { v: "keep", c: 0.9, why: "", sum: "", lb: "三月/帳單繳費" })?.autoFile, true);
  eq(decide(personal, null, { v: "keep", c: 0.6, why: "", sum: "", lb: "三月/帳單繳費" })?.autoFile, false);
  eq(decide(personal, null, { v: "report", c: 0.99, why: "", sum: "", lb: "五年/產品營運" })?.autoFile, false);
  eq(decide(personal, null, { v: "keep", c: 0.99, why: "", sum: "", lb: "待辦" })?.autoFile, false);
});

t("自建分類：在現行清單裡才算數", () => {
  const labels = [...LABELS, "五年/課程學習"];
  eq(decide(personal, null, { v: "keep", c: 0.9, why: "", sum: "", lb: "五年/課程學習" }, labels)?.label, "五年/課程學習");
  eq(decide(personal, null, { v: "keep", c: 0.9, why: "", sum: "", lb: "五年/課程學習" })?.label, undefined);
  const out = parseClassify('[{"i":0,"v":"keep","c":1,"lb":"五年/課程學習"}]', 1, labels);
  eq(out[0]?.lb, "五年/課程學習");
  if (!classifySys(["五年/課程學習"]).includes("五年/課程學習")) throw new Error("自建分類沒進提示詞");
});

t("新分類名稱：只准長在三層底下、2～8 字", () => {
  for (const ok of ["五年/課程學習", "永久/作品集", "三月/電信"]) eq(isValidNewLabel(ok), true);
  for (const bad of ["待辦", "課程", "一年/課程", "五年/", "五年/一", "五年/這個名字實在太長了啦", "五年/a/b"]) eq(isValidNewLabel(bad), false);
});

t("AI 的備選與新分類：清單外的丟掉、跟推薦重複的丟掉、新分類撞名現有的丟掉", () => {
  const out = parseClassify('[{"i":0,"v":"report","c":1,"lb":"五年/產品營運","alt":["五年/產品營運","亂寫","待辦","五年/保固憑證"],"nw":"五年/產品營運"},{"i":1,"v":"keep","c":1,"nw":"永久/作品集"}]', 2);
  eq(out[0]?.alt, ["五年/保固憑證"]); eq(out[0]?.nw, undefined); eq(out[1]?.nw, "永久/作品集");
});

t("卡片選項：推薦在第一、待辦不佔名額、最多三個不重複", () => {
  eq(fileOptions("五年/產品營運", { v: "report", c: 1, why: "", sum: "", lb: "五年/產品營運", alt: ["待辦", "五年/保固憑證", "永久/重要內容"] }),
    ["五年/產品營運", "五年/保固憑證", "永久/重要內容"]);
  eq(fileOptions(undefined, null), []);
});

t("卡片按鈕：callback 都在 64 bytes 內、解析得回來；不把中文標籤塞進 callback", () => {
  const rows = fileButtons(987654321012, ["五年/產品營運", "五年/保固憑證", "永久/重要內容"], "五年/課程學習");
  const all = rows.flat();
  for (const b of all) {
    if (new TextEncoder().encode(b.callback_data).length > 64) throw new Error("超過 64 bytes：" + b.callback_data);
    if (!parseMbCallback(b.callback_data)) throw new Error("解析不回來：" + b.callback_data);
    if (/[\u4e00-\u9fff]/.test(b.callback_data)) throw new Error("callback 裡有中文：" + b.callback_data);
  }
  if (!all[0].text.startsWith("⭐")) throw new Error("推薦沒有放第一顆");
  for (const op of ["o0", "o1", "o2", "n", "p", "t", "T", "D"]) if (!all.some((b) => b.callback_data.startsWith(`mb:${op}:`))) throw new Error("少了 " + op);
  eq(parseMbCallback("mb:o3:1"), null);
});

t("卡片文案：有推薦就寫推薦，沒有就說都不合適；新分類建議要出現；HTML 轉義", () => {
  const a = fileText({ from: "A <a@b.c>", subject: "x<y", snippet: "s", reason: "r" }, ["五年/產品營運"], null);
  if (!a.includes("推薦放「五年/產品營運」") || !a.includes("x&lt;y")) throw new Error(a);
  const b = fileText({ from: "A <a@b.c>", subject: "x", snippet: "s", reason: "" }, [], "永久/作品集");
  if (!b.includes("都不太合適") || !b.includes("永久/作品集")) throw new Error(b);
});

t("自建分類也會到期清理；永久層的自建分類不會", () => {
  const q = sweepFor([...LABELS, "三月/電信", "永久/作品集"]);
  if (!q.some((x) => x.label === "三月/電信" && x.q === "label:三月-電信 older_than:3m")) throw new Error("三月/電信 沒有清理");
  if (q.some((x) => x.label.startsWith("永久") || x.label === "待辦")) throw new Error("清單混進永久或待辦");
  eq(SWEEP.length, sweepFor(LABELS).length);
});

t("信箱週報帶出清理數與待辦；沒東西時也說清楚", () => {
  const s = mailWeeklyText({ trashed: 40, filed: 12, cards: 5, open: 1, rules: 30, newLabels: ["五年/課程學習"],
    sweep: { swept: 12, byLabel: { "三月/帳單繳費": 12 }, todo: 3, todoOldestDays: 9 } });
  for (const k of ["刪 40", "自動歸檔 12", "到期清理 12 封", "三月/帳單繳費 12", "待辦還有 3 封", "放了 9 天", "五年/課程學習"]) if (!s.includes(k)) throw new Error(`少了「${k}」`);
  const e = mailWeeklyText({ trashed: 0, filed: 0, cards: 0, open: 0, rules: 0, newLabels: [] });
  if (!e.includes("本週沒有到期的信") || !e.includes("待辦清空")) throw new Error(e);
  if (/產品|起卦|營收/.test(s + e)) throw new Error("信箱週報混進了產品數據");
});

setTimeout(() => {
  console.log(`\n${pass} 過、${fail} 敗`);
  if (fail) process.exit(1);
});
