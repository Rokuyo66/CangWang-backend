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
  isValidNewLabel, classifySys, parseRuleIntent, describeOp, ruleNlPrompt, ruleNlSys, type Rule, type Meta,
  reminderDue, reminderText, upcomingText, taipeiDate, classifyPrompt, isSupport, parseSupport,
  parseCharges, toTwd, monthlyText, parseNews, newsText, type ChargeRow,
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

// ── 用說的改規則 ──
const ids = new Set([3, 7]);
t("用說的：品牌→網域、大小寫與網址前綴收乾淨", () => {
  const r = parseRuleIntent('{"ops":[{"op":"add","kind":"domain","pattern":"https://Shopee.TW/","action":"trash"}],"say":""}', LABELS, ids);
  eq(r.ops, [{ op: "add", kind: "domain", pattern: "shopee.tw", action: "trash", label: null }]);
});

t("用說的：格式不對的一律丟掉，不上確認卡", () => {
  const r = parseRuleIntent(JSON.stringify({ ops: [
    { op: "add", kind: "sender", pattern: "沒有小老鼠", action: "trash" },
    { op: "add", kind: "domain", pattern: "a@b.com", action: "trash" },
    { op: "add", kind: "subject", pattern: "x", action: "trash" },
    { op: "add", kind: "domain", pattern: "ok.com", action: "nuke" },
    { op: "add", kind: "domain", pattern: "ok.com", action: "trash", label: "五年/產品營運" },   // 要刪又要歸檔
    { op: "add", kind: "domain", pattern: "ok.com", action: "keep", label: "亂寫的分類" },
    { op: "del", id: 999 },
  ], say: "" }), LABELS, ids);
  eq(r.ops, []);
});

t("用說的：只能刪現有的規則、重複的只算一次", () => {
  const r = parseRuleIntent('{"ops":[{"op":"del","id":3},{"op":"del","id":3},{"op":"del","id":4}]}', LABELS, ids);
  eq(r.ops, [{ op: "del", id: 3 }]);
});

t("用說的：新分類要合法才收，並列入要新開的清單", () => {
  const r = parseRuleIntent('{"ops":[{"op":"add","kind":"sender","pattern":"a@b.com","action":"keep","label":"五年/課程學習"},{"op":"add","kind":"sender","pattern":"c@d.com","action":"keep","label":"待辦"}]}', LABELS, ids);
  eq(r.ops.length, 1); eq(r.newLabels, ["五年/課程學習"]);
});

t("用說的：一句最多 5 條；看不懂時帶回 say、沒有操作", () => {
  const many = { ops: Array.from({ length: 9 }, (_, i) => ({ op: "add", kind: "domain", pattern: `x${i}.com`, action: "trash" })) };
  eq(parseRuleIntent(JSON.stringify(many), LABELS, ids).ops.length, 5);
  const q = parseRuleIntent('{"ops":[],"say":"你是指哪個寄件人？"}', LABELS, ids);
  eq([q.ops.length, q.say], [0, "你是指哪個寄件人？"]);
  eq(parseRuleIntent("我不輸出 JSON", LABELS, ids).ops, []);
});

t("用說的：確認卡文案講清楚會發生什麼，HTML 轉義", () => {
  const rules = [{ id: 3, kind: "domain" as const, pattern: "104.com.tw", action: "trash" as const, label: null }];
  if (!describeOp({ op: "del", id: 3 }, rules).includes("104.com.tw")) throw new Error("刪除沒寫出是哪條");
  if (!describeOp({ op: "add", kind: "sender", pattern: "a<b@c.d", action: "keep", label: "永久/房產" }).includes("a&lt;b@c.d")) throw new Error("沒轉義");
  if (!describeOp({ op: "add", kind: "domain", pattern: "x.com", action: "keep", label: null }).includes("不刪")) throw new Error("keep 沒說明");
  if (!ruleNlPrompt("hi", rules).includes("#3 domain 104.com.tw")) throw new Error("現有規則沒帶給模型");
  if (ruleNlSys(LABELS).includes("待辦、") ) throw new Error("待辦不該是規則可選的分類");
});

t("確認卡按鈕：Y／N 解析得回來", () => {
  eq(parseMbCallback("mb:Y:12"), { op: "Y", id: 12 }); eq(parseMbCallback("mb:N:12"), { op: "N", id: 12 });
});

// ── 到期日提醒 ──
t("到期日：只收今天到兩年內；格式錯、過去的、離譜的都丟", () => {
  eq(reminderDue("2026-10-22", "2026-10-20"), "2026-10-22");
  eq(reminderDue("2026-10-20", "2026-10-20"), "2026-10-20");
  eq(reminderDue("2026-10-19", "2026-10-20"), null);
  eq(reminderDue("2029-01-01", "2026-10-20"), null);
  eq(reminderDue("10/22", "2026-10-20"), null); eq(reminderDue(undefined, "2026-10-20"), null);
});

t("到期日：分類時抓得到 due／chg，日期格式不對的丟掉；提示詞帶今天", () => {
  const out = parseClassify('[{"i":0,"v":"report","c":1,"due":"2026-12-04","dw":"健檢","chg":false},{"i":1,"v":"keep","c":1,"due":"下週","chg":true}]', 2);
  eq([out[0]?.due, out[0]?.dw, out[0]?.chg], ["2026-12-04", "健檢", undefined]);
  eq([out[1]?.due, out[1]?.chg], [undefined, true]);
  if (!classifyPrompt([{ from: "a", subject: "b", snippet: "c" }], "2026-10-20").startsWith("今天是 2026-10-20")) throw new Error("沒帶今天");
});

t("台北日期：UTC 16:30 已經是台北隔天", () => {
  eq(taipeiDate(Date.parse("2026-10-20T16:30:00Z")), "2026-10-21");
  eq(taipeiDate(Date.parse("2026-10-20T15:59:00Z"), 1), "2026-10-21");
});

t("提醒文案：分今天／明天、轉義；清單算得出幾天後", () => {
  const s = reminderText([{ id: 1, due_date: "2026-10-22", what: "金鑰<到期>", sender: "A", subject: "x" }], []);
  if (!s.includes("今天（10-22）") || !s.includes("金鑰&lt;到期&gt;")) throw new Error(s);
  const u = upcomingText([{ id: 1, due_date: "2026-10-21", what: "繳費", sender: null, subject: null }, { id: 2, due_date: "2026-12-04", what: "健檢", sender: null, subject: null }], "2026-10-20");
  if (!u.includes("明天") || !u.includes("45 天後")) throw new Error(u);
});

// ── 客服信 ──
t("客服：To／Cc／Delivered-To 任一含客服地址才算，大小寫不拘", () => {
  eq(isSupport("Support@Jizhiguan.com", "support@jizhiguan.com"), true);
  eq(isSupport("me@gmail.com, support@jizhiguan.com", "support@jizhiguan.com"), true);
  eq(isSupport("rokuyo221@gmail.com", "support@jizhiguan.com"), false);
  eq(isSupport("anything", ""), false);
});

t("客服：沒有回信內容的不算；類別不認得的歸其他", () => {
  eq(parseSupport('{"cat":"bug","urgent":true,"sum":"閃退","reply":"您好…"}')?.urgent, true);
  eq(parseSupport('{"cat":"亂寫","reply":"您好"}')?.cat, "other");
  eq(parseSupport('{"cat":"bug","reply":""}'), null);
  eq(parseSupport("不是 JSON"), null);
});

// ── 帳單 ──
t("帳單：金額要是正數、幣別三碼；壞的那封回 null", () => {
  const out = parseCharges('[{"i":0,"vendor":"Anthropic","currency":"usd","amount":12.5,"kind":"product"},{"i":1,"vendor":"X","currency":"TWD","amount":null},{"i":2,"vendor":"Y","currency":"新台幣","amount":100},{"i":3,"vendor":"Z","currency":"TWD","amount":-5}]', 4);
  eq(out[0], { vendor: "Anthropic", currency: "USD", amount: 12.5, kind: "product", sub: false });
  eq([out[1], out[2], out[3]], [null, null, null]);
});

t("帳單：換台幣；沒匯率的幣別回 null（報表另列原幣）", () => {
  eq(toTwd({ currency: "TWD", amount: 270 }, {}), 270);
  eq(toTwd({ currency: "USD", amount: 10 }, { USD: 32 }), 320);
  eq(toTwd({ currency: "GBP", amount: 10 }, { USD: 32 }), null);
});

t("月報：分產品／個人加總、暴增標 ⚠️、小額波動不標、列出訂閱", () => {
  const r = (vendor: string, twd: number, kind: "product" | "personal", sub = false): ChargeRow => ({ vendor, currency: "TWD", amount: twd, twd, kind, sub });
  const s = monthlyText("2026-10", [r("Anthropic", 900, "product"), r("Spotify", 149, "personal", true), r("小額", 60, "personal")],
    [r("Anthropic", 300, "product"), r("Spotify", 149, "personal", true), r("小額", 20, "personal")]);
  if (!s.includes("⚠️ Anthropic") || !s.includes("上月 300")) throw new Error("暴增沒標：\n" + s);
  if (s.includes("⚠️ 小額")) throw new Error("小額波動不該標");
  if (!s.includes("NT$ 900") || !s.includes("個人訂閱 1 個：Spotify")) throw new Error(s);
});

// ── 政府消息 ──
t("政府消息：只收 gov.tw 與機場公司的網址（含子網域），其他一律丟", () => {
  const items = parseNews(JSON.stringify([
    { title: "區段徵收公告", date: "2026-10-15", url: "https://www.tycg.gov.tw/news/1", sum: "a" },
    { title: "機場公告", date: "", url: "https://www.taoyuan-airport.com/x", sum: "b" },
    { title: "新聞網", url: "https://news.example.com/x", sum: "c" },
    { title: "假冒", url: "https://gov.tw.evil.com/x", sum: "d" },
    { title: "http", url: "http://www.tycg.gov.tw/x", sum: "e" },
  ]));
  eq(items.map((x) => x.title), ["區段徵收公告", "機場公告"]);
});

t("政府消息：沒有新的就說沒有；連結與標題轉義", () => {
  if (!newsText([]).includes("沒有新公告")) throw new Error("空的沒說");
  const s = newsText([{ title: "A<B", date: "2026-10-15", url: "https://x.gov.tw/?a=1&b=2", sum: "s" }]);
  if (!s.includes("A&lt;B") || !s.includes("a=1&amp;b=2")) throw new Error(s);
});

t("新按鈕 R（提醒處理好了）解析得回來", () => { eq(parseMbCallback("mb:R:5"), { op: "R", id: 5 }); });

setTimeout(() => {
  console.log(`\n${pass} 過、${fail} 敗`);
  if (fail) process.exit(1);
});
