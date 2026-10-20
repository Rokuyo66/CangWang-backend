// _shared/mailbot.ts — 信箱管家的判斷與文案（純函式，不碰網路、不碰 Deno.env，node 測得到）
//
// 觀主要的是「收件匣清零」：收件匣只放待辦，和他還沒處理的信；其他一律歸檔、標已讀，左欄不出現未讀數。
//
// 一封信的去處：
//   trash    → 丟垃圾桶（Gmail 30 天後自動清，空間回來）
//   自動歸檔 → 規則指定了標籤，或 AI 很有把握的留存信：貼標籤、移出收件匣、標已讀
//   歸檔卡   → 其餘的（要他看的、拿不準的）留在收件匣未讀，TG 推一張卡：⭐推薦標籤、備選、
//              都不合適時建議新分類、待辦、刪。按下去就歸檔；再按一下「以後都放這」就長成規則
//
// decision 的四個值仍是 report／trash／keep／ask——卡片上的標題據此不同（📨 要你看／❓ 拿不準）
//
// 【順序】觀主的規則 > 守門關鍵字 > AI 判斷。
// 【鐵則】寧可多問一封，不可錯刪一封。AI 說刪但信心不夠、或不是廣告型的信，一律改問。
//         守門關鍵字（銀行、帳單、驗證碼、政府、合約…）命中的信，AI 再怎麼說刪也只能問。

export type Decision = "report" | "trash" | "keep" | "ask";
export type Rule = { id: number; kind: "sender" | "domain" | "subject"; pattern: string; action: "trash" | "report" | "keep"; label?: string | null };
export type AiVerdict = {
  v: Decision; c: number; why: string; sum: string; lb?: string; alt?: string[]; nw?: string;
  due?: string; dw?: string;   // 信裡有要觀主記得的日期（截止、預約、到期）：YYYY-MM-DD 與一句話
  chg?: boolean;               // 這是一筆扣款／帳單／收據
};

/* ── 保留期限標籤（觀主的 Gmail 標籤，名稱逐字對應）──────────────
   分類依據不是「主題」而是「要留多久」：
     三月：原平台查得回來（銀行 App、財政部載具、保險公司官網）→ 3 個月後刪
     五年：稅務與營運憑證、保固 → 5 年後刪
     永久：查不回來且還會用到（序號、合約、房產）
     待辦：要觀主動手的，處理完由他移走；有日期在未來的事（預約、機票）也先放這裡，
           因為三月是從「收到那天」起算，十月的機票五月訂，八月就會被清掉 */
export const LABELS = [
  "三月/水電瓦斯", "三月/保險通知", "三月/帳單繳費",
  "五年/外包收入", "五年/保固憑證", "五年/產品營運", "五年/錄取通知",
  "永久/合約明細", "永久/房產", "永久/金鑰序號", "永久/重要內容",
  "待辦",
] as const;
export const TODO = "待辦";
export const inList = (list: readonly string[], s: unknown): s is string => typeof s === "string" && list.includes(s);
export const isLabel = (s: unknown): s is string => inList(LABELS, s);

/** 新分類只准長在三層底下、名字 2～8 字。AI 建議的、觀主按出來的都過這一關——
 *  不在三層底下的標籤沒有到期日，等於又開了一個永遠不會清的抽屜。 */
export const NEW_LABEL_RE = /^(三月|五年|永久)\/[\p{L}\p{N}]{2,8}$/u;
export const isValidNewLabel = (s: unknown): s is string => typeof s === "string" && NEW_LABEL_RE.test(s);

/** 到期清理（三月 3 個月、五年 5 年）。Gmail 搜尋語法裡巢狀標籤的「/」寫成「-」。
 *  從標籤名稱推出來，觀主新開的分類自動納入，不必另外登記。 */
export function sweepFor(labels: readonly string[]) {
  return labels.filter((l) => /^(三月|五年)\//.test(l))
    .map((l) => ({ q: `label:${l.replace(/\//g, "-")} older_than:${l.startsWith("三月") ? "3m" : "5y"}`, label: l }));
}
export const SWEEP = sweepFor(LABELS);
export type Meta = {
  from: string; subject: string; snippet: string;
  labels: string[]; listUnsubscribe: boolean;
};

export const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "王小明 <Foo@Bar.com>" → { email: "foo@bar.com", name: "王小明", domain: "bar.com" } */
export function parseFrom(from: string): { email: string; name: string; domain: string } {
  const s = String(from ?? "").trim();
  const m = s.match(/<([^>]+)>/);
  const email = (m ? m[1] : s).trim().toLowerCase();
  const name = (m ? s.slice(0, m.index).trim().replace(/^"|"$/g, "") : "") || email;
  const domain = email.includes("@") ? email.split("@").pop()! : "";
  return { email, name, domain };
}

/** 網域規則比的是「主網域」：news.shopee.tw 也算 shopee.tw。 */
export function domainMatches(domain: string, pattern: string): boolean {
  const d = domain.toLowerCase(), p = pattern.toLowerCase().replace(/^@/, "");
  return d === p || d.endsWith("." + p);
}

const RANK: Record<Rule["kind"], number> = { sender: 0, domain: 1, subject: 2 };
const SAFE_FIRST: Record<Rule["action"], number> = { report: 0, keep: 1, trash: 2 };

/** 找出這封信適用的規則：越具體越優先；同一層裡 report／keep 勝過 trash。 */
export function matchRule(meta: Meta, rules: Rule[]): Rule | null {
  const { email, domain } = parseFrom(meta.from);
  const subj = String(meta.subject ?? "").toLowerCase();
  const hit = rules.filter((r) => {
    const p = r.pattern.toLowerCase();
    if (r.kind === "sender") return email === p;
    if (r.kind === "domain") return !!domain && domainMatches(domain, p);
    return !!p && subj.includes(p);
  });
  hit.sort((a, b) => RANK[a.kind] - RANK[b.kind] || SAFE_FIRST[a.action] - SAFE_FIRST[b.action]);
  return hit[0] ?? null;
}

// 守門：這些字出現在寄件人、主旨或摘要裡，就不准自動刪。
// 不是「一定重要」，是「刪錯的代價太高」——錯刪一封扣款通知比多看十封廣告貴得多。
export const GUARD = new RegExp([
  // 金流與帳務
  "銀行", "帳單", "繳費", "扣款", "付款", "刷卡", "信用卡", "轉帳", "匯款", "發票", "收據", "退款", "對帳",
  "invoice", "receipt", "payment", "billing", "refund", "bank", "statement",
  // 帳號安全
  "驗證碼", "密碼", "登入", "安全性", "異常", "otp", "verification", "password", "security", "sign-in", "2fa",
  // 公務、法務、保險、醫療
  "國稅", "稅", "健保", "勞保", "監理", "法院", "地檢", "戶政", "政府", "gov", "保險", "保單", "醫院", "診所",
  // 合約與工作
  "合約", "契約", "租約", "簽署", "面試", "錄取", "offer", "薪資", "contract",
  // 觀主自己的事：建案與產品金流
  "建案", "預售", "交屋", "貸款", "房貸", "航空城", "綠界", "ecpay", "supabase", "cloudflare", "google play", "app store", "anthropic",
].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

export const guardHit = (m: Meta) => GUARD.test(`${m.from}\n${m.subject}\n${m.snippet}`);

/** 像廣告／電子報的信：Gmail 分在「促銷／社交／論壇」，或帶退訂標頭。只有這種信 AI 才能自己刪。 */
export const looksBulk = (m: Meta) =>
  m.listUnsubscribe || m.labels.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_SOCIAL" || l === "CATEGORY_FORUMS");

export const AUTO_TRASH_CONF = 0.85;

/** 決定去處。ai 為 null（模型沒回）時回 null：這封先不處理，下一輪再看——不記錄就不會被當成「看過了」。 */
export const AUTO_FILE_CONF = 0.85;

export type Decided = { decision: Decision; source: "rule" | "ai" | "guard"; reason: string; label?: string; autoFile?: boolean };

/** labels＝現行可用的標籤（固定清單＋觀主自建的）。 */
export function decide(meta: Meta, rule: Rule | null, ai: AiVerdict | null, labels: readonly string[] = LABELS): Decided | null {
  const d = decideCore(meta, rule, ai);
  if (!d || (d.decision !== "report" && d.decision !== "keep")) return d;
  // 留下來的信才有標籤；規則指定的優先，其次 AI 建議的
  const ruleLabel = rule && inList(labels, rule.label) ? rule.label : undefined;
  const label = ruleLabel ?? (inList(labels, ai?.lb) ? ai!.lb : undefined);
  if (!label) return d;
  // 自動歸檔只在兩種情況：觀主的規則指定了標籤（他已經決定過），
  // 或 AI 很有把握的「留存不必看」。要他看的、待辦，一律留在收件匣讓他自己按。
  const autoFile = label !== TODO && (!!ruleLabel || (d.decision === "keep" && (ai?.c ?? 0) >= AUTO_FILE_CONF));
  return { ...d, label, autoFile };
}

function decideCore(meta: Meta, rule: Rule | null, ai: AiVerdict | null):
  { decision: Decision; source: "rule" | "ai" | "guard"; reason: string } | null {
  const guarded = guardHit(meta);
  if (rule) {
    // 主旨關鍵字是最粗的規則，可能誤套到帳單、驗證碼上；守門字命中時改問，不照刪
    if (rule.action === "trash" && rule.kind === "subject" && guarded)
      return { decision: "ask", source: "guard", reason: `規則「${rule.pattern}」要刪，但信裡有守門字` };
    return { decision: rule.action, source: "rule", reason: `規則：${KIND_LABEL[rule.kind]} ${rule.pattern}` };
  }
  if (!ai) return null;
  if (ai.v === "trash") {
    if (guarded) return { decision: "ask", source: "guard", reason: ai.why || "AI 想刪，但含守門字" };
    if (ai.c >= AUTO_TRASH_CONF && looksBulk(meta)) return { decision: "trash", source: "ai", reason: ai.why };
    return { decision: "ask", source: "ai", reason: ai.why || "AI 傾向刪，但不夠確定" };
  }
  return { decision: ai.v, source: "ai", reason: ai.why };
}

export const KIND_LABEL: Record<Rule["kind"], string> = { sender: "寄件人", domain: "網域", subject: "主旨含" };
export const ACTION_LABEL: Record<Rule["action"], string> = { trash: "🗑 直接刪", report: "📌 一律回報", keep: "📥 留著不報" };

/* ── AI 分類 ─────────────────────────────────────────────── */

/** extra＝觀主自建的分類，接在固定清單後面讓模型也能選。 */
export function classifySys(extra: readonly string[] = []): string {
  const extraLines = extra.length ? extra.map((l) => `- ${l}：觀主自建的分類，依名稱判斷\n`).join("") : "";
  return `你是「觀主」的信箱管家。觀主是台灣的遊戲 UI 設計師，也是占卜 App「藏往知來／幾知觀」的開發者兼營運者，另外在追蹤桃園航空城的建案。

每封信只給你寄件人、主旨、摘要。為每一封決定去處：
- report：觀主需要知道或需要動手處理的。真人寫來的信、工作與合作邀約、帳單與扣款、帳號安全警示、政府與法務、建案進度、產品相關（用戶來信、App 審核、金流、伺服器與 API 用量或費用警示、服務中斷）。
- keep：有留存價值但不必看——一般訂單或出貨通知、已繳費的收據、例行的服務條款更新。
- trash：看完就沒用的——廣告、促銷、電子報、社群通知（按讚、追蹤、推薦）、行銷問卷、過期的活動。
- ask：你拿不準。

c 是你對這個判斷的信心（0～1）。只有明顯的廣告／電子報才給 trash 高信心；只要有一點可能是觀主要的，就給 ask。
why 用 12 字內說理由。sum 只在 report 時寫：一句話（30 字內）講觀主要知道什麼、要做什麼。

lb 是保留期限標籤，只在 report 或 keep 時給，從下面挑一個（都不適合就給空字串）。判準是「這封信能不能在別處查回來、還會不會用到」：
- 三月/帳單繳費：信用卡帳單、扣款與繳費通知、一般消費發票（銀行 App 或財政部載具查得回來）
- 三月/水電瓦斯：水費、電費、瓦斯費、電信費
- 三月/保險通知：保費繳費通知（不含保單本身）
- 五年/產品營運：藏往知來的營運費用與憑證——Anthropic、Supabase、Cloudflare、Google Cloud、Google Play 開發者、綠界的收據與發票。國外服務不開台灣發票，這封信就是唯一憑證
- 五年/外包收入：外包合作、報酬、扣繳憑單
- 五年/保固憑證：3C、電腦零件、家電的購買證明
- 五年/錄取通知：應徵、面試、錄取往來
- 永久/合約明細：租約、保單本體與條款、勞動或外包合約
- 永久/房產：建案、預售屋、付款期程、交屋、貸款
- 永久/金鑰序號：軟體序號、授權證明、字型與素材授權、2FA 備用碼與救援碼
- 永久/重要內容：證件、公文、健檢報告等查不回來的個人文件
- 待辦：要觀主動手的，或有未來日期的事（預約、機票、即將到期的金鑰或服務、平台規則變更要配合）
${extraLines}一次性驗證碼、登入通知、物流進度這類用完即棄的，不給標籤。

alt：除了 lb 以外，次適合的標籤，最多兩個（陣列，可空）。
nw：上面的標籤都不太合適、但這類信值得長期歸一處時，建議一個新分類，格式「三月/xx」「五年/xx」「永久/xx」（xx 為 2～8 字）；否則給空字串。依同一個判準選層：查得回來→三月，憑證→五年，查不回來還會用→永久。

due／dw：信裡有觀主要記得、而且在今天之後的日期（繳費截止、預約、活動、金鑰或服務到期、合約續約、申報期限），due 給 YYYY-MM-DD、dw 用 15 字內說是什麼事；沒有就都給空字串。只看信裡明寫的日期，換算時以使用者訊息開頭的「今天」為準；行銷活動的截止日不算。
chg：這封是一筆實際發生的扣款、帳單或收據（不是廣告、不是消費通知以外的推銷）給 true，否則 false。

只輸出 JSON 陣列，不要任何其他字：[{"i":0,"v":"report","c":0.9,"why":"…","sum":"…","lb":"五年/產品營運","alt":["五年/保固憑證"],"nw":"","due":"","dw":"","chg":true}, …]`;
}
export const CLASSIFY_SYS = classifySys();

export function classifyPrompt(items: { from: string; subject: string; snippet: string }[], today?: string): string {
  return (today ? `今天是 ${today}（台北）\n\n` : "") + items.map((m, i) =>
    `#${i}\n寄件人：${m.from.slice(0, 120)}\n主旨：${m.subject.slice(0, 200)}\n摘要：${m.snippet.slice(0, 300)}`).join("\n\n");
}

/** 容錯解析：模型偶爾包 ```json 或多話。缺的、壞的那一封回 null（下一輪重判）。 */
export function parseClassify(text: string, n: number, labels: readonly string[] = LABELS): (AiVerdict | null)[] {
  const out: (AiVerdict | null)[] = Array(n).fill(null);
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const x of arr as Record<string, unknown>[]) {
    const i = Number(x?.i);
    const v = String(x?.v ?? "");
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    if (!["report", "trash", "keep", "ask"].includes(v)) continue;
    const c = Math.max(0, Math.min(1, Number(x?.c ?? 0) || 0));
    out[i] = { v: v as Decision, c, why: String(x?.why ?? "").slice(0, 40), sum: String(x?.sum ?? "").slice(0, 80) };
    const v0 = out[i]!;
    if (inList(labels, x?.lb)) v0.lb = x.lb as string;
    const alt = (Array.isArray(x?.alt) ? x.alt : []).filter((a: unknown) => inList(labels, a) && a !== v0.lb && a !== TODO);
    if (alt.length) v0.alt = [...new Set(alt as string[])].slice(0, 2);
    if (isValidNewLabel(x?.nw) && !labels.includes(x.nw as string)) v0.nw = x.nw as string;
    if (isDate(x?.due)) { v0.due = x.due as string; v0.dw = String(x?.dw ?? "").slice(0, 30); }
    if (x?.chg === true) v0.chg = true;
  }
  return out;
}

/* ── TG 按鈕 ─────────────────────────────────────────────── */
// callback_data 上限 64 bytes：mb:<動作>:<mailbot_seen.id>
//   o0／o1／o2  歸檔到卡上第 n 個標籤（選項存在 mailbot_seen.options，不把標籤名塞進 callback）
//   n  開新分類（mailbot_seen.suggest）並歸檔      p  待辦：貼待辦、標已讀、留在收件匣
//   A  以後這個寄件人都自動放進剛剛選的標籤
//   t 刪這封   T 刪＋此寄件人以後都刪   D 刪＋此網域以後都刪
//   u 從垃圾桶救回（/maillog）   k／K 舊版卡片的「留」「以後都報」，舊訊息上的按鈕還按得動
//   Y／N  用說的改規則：確認／取消（id 是 mailbot_rule_drafts 的，不是 mailbot_seen 的）
//   R  到期提醒「處理好了」（id 是 mailbot_reminders 的）
export type MbOp = "o0" | "o1" | "o2" | "n" | "p" | "A" | "t" | "T" | "D" | "k" | "K" | "u" | "Y" | "N" | "R";
export const mbCallback = (op: MbOp, id: number) => `mb:${op}:${id}`;
export function parseMbCallback(data: string): { op: MbOp; id: number } | null {
  const m = /^mb:(o[0-2]|[nApTtDkKuYNR]):(\d{1,15})$/.exec(data ?? "");
  return m ? { op: m[1] as MbOp, id: Number(m[2]) } : null;
}

/** 卡上的歸檔選項：AI 推薦的排第一，再來是備選；待辦另有一顆鈕，不佔名額。最多三個。 */
export function fileOptions(label: string | undefined, ai: AiVerdict | null): string[] {
  const out: string[] = [];
  for (const l of [label, ai?.lb, ...(ai?.alt ?? [])]) if (l && l !== TODO && !out.includes(l)) out.push(l);
  return out.slice(0, 3);
}

export function fileButtons(id: number, options: string[], suggest?: string | null) {
  const opt = options.slice(0, 3).map((l, i) => ({ text: (i === 0 ? "⭐ " : "") + l, callback_data: mbCallback(`o${i}` as MbOp, id) }));
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < opt.length; i += 2) rows.push(opt.slice(i, i + 2));
  const second = [{ text: "📌 待辦（留收件匣）", callback_data: mbCallback("p", id) }];
  if (suggest) second.push({ text: "🆕 " + suggest, callback_data: mbCallback("n", id) });
  rows.push(second);
  rows.push([
    { text: "🗑 刪", callback_data: mbCallback("t", id) },
    { text: "🗑 寄件人都刪", callback_data: mbCallback("T", id) },
    { text: "🗑 網域都刪", callback_data: mbCallback("D", id) },
  ]);
  return rows;
}

/* ── 文案 ────────────────────────────────────────────────── */

export function fileText(m: { from: string; subject: string; snippet: string; reason: string; sum?: string; ask?: boolean },
  options: string[], suggest?: string | null): string {
  const f = parseFrom(m.from);
  const lines = [
    m.ask ? "❓ <b>這封要留嗎？留的話放哪？</b>" : "📨 <b>這封放哪？</b>",
    `<b>${esc(f.name)}</b>　<code>${esc(f.email)}</code>`,
    esc(m.subject || "（無主旨）"),
    `<i>${esc(m.snippet.slice(0, 120))}${m.snippet.length > 120 ? "…" : ""}</i>`,
  ];
  if (m.sum) lines.push("", `→ ${esc(m.sum)}`);
  const tail: string[] = [];
  if (options[0]) tail.push(`⭐ 推薦放「${esc(options[0])}」`);
  else tail.push("現有分類都不太合適");
  if (suggest) tail.push(`💡 可以開新分類「${esc(suggest)}」`);
  if (m.reason) tail.push(`🤖 ${esc(m.reason)}`);
  return [...lines, "", ...tail].join("\n");
}

export type DigestItem = { from: string; subject: string; sum: string };
export type DigestCounts = { trashed: number; kept: number; asked: number; skipped: number; trashedSenders: string[]; labeled?: Record<string, number> };

/** 一輪整理的匯報。沒有要報的、也沒刪東西，就回空字串（不發，免得每兩小時吵一次「沒事」）。 */
export function digestText(items: DigestItem[], c: DigestCounts): string {
  if (!items.length && !c.trashed && !c.asked) return "";
  const lines = [`📬 <b>信箱整理</b>`];
  if (items.length) {
    lines.push("", `<b>需要你知道（${items.length}）</b>`);
    for (const it of items.slice(0, 15)) {
      const f = parseFrom(it.from);
      lines.push(`• <b>${esc(f.name.slice(0, 24))}</b>｜${esc(it.subject.slice(0, 60) || "（無主旨）")}` +
        (it.sum ? `\n　→ ${esc(it.sum)}` : ""));
    }
    if (items.length > 15) lines.push(`…另有 ${items.length - 15} 封，請到 Gmail 看`);
  }
  const tail: string[] = [];
  if (c.trashed) {
    const top = c.trashedSenders.slice(0, 5).map(esc).join("、");
    tail.push(`🗑 已刪 ${c.trashed} 封${top ? `（${top}${c.trashedSenders.length > 5 ? "…" : ""}）` : ""}`);
  }
  if (c.kept) tail.push(`🗂 自動歸檔 ${c.kept} 封（已讀，不在收件匣）`);
  const lab = Object.entries(c.labeled ?? {}).filter(([, n]) => n > 0);
  if (lab.length) tail.push(`🏷 歸檔：${lab.map(([k, n]) => `${esc(k)} ${n}`).join("、")}`);
  if (c.asked) tail.push(`📨 待你歸檔 ${c.asked} 封（見上方各張卡片，在收件匣等你）`);
  if (c.skipped) tail.push(`⏳ ${c.skipped} 封 AI 沒判出來，下一輪再看`);
  if (tail.length) lines.push("", ...tail);
  lines.push("", `<i>刪錯了：垃圾桶 30 天內都撿得回來；/mailrules 看規則</i>`);
  return lines.join("\n");
}

/* ── 信箱週報（每週一，跟到期清理一起發）──────────────────────
   產品週報不在這裡：那是產品的數據，留在產品專案（CangWang-backend 的 weekly-report）。 */

export type MailWeek = {
  trashed: number; filed: number; cards: number; open: number; rules: number; newLabels: string[];
  sweep?: { swept: number; byLabel: Record<string, number>; todo: number; todoOldestDays: number | null };
};

export function mailWeeklyText(w: MailWeek): string {
  const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");
  return [
    `📬 <b>信箱週報</b>`,
    `近 7 天：刪 ${n(w.trashed)}　自動歸檔 ${n(w.filed)}　推卡 ${n(w.cards)}　還沒按的卡 ${n(w.open)}`,
    `規則 ${n(w.rules)} 條` + (w.newLabels.length ? `　本週新分類：${w.newLabels.map(esc).join("、")}` : ""),
    w.sweep && w.sweep.swept
      ? `🧹 到期清理 ${n(w.sweep.swept)} 封：` + Object.entries(w.sweep.byLabel).filter(([, v]) => v > 0).map(([k, v]) => `${esc(k)} ${n(v)}`).join("、")
      : `🧹 本週沒有到期的信`,
    w.sweep && w.sweep.todo
      ? `📌 待辦還有 ${n(w.sweep.todo)} 封` + (w.sweep.todoOldestDays !== null ? `，最舊的放了 ${w.sweep.todoOldestDays} 天` : "")
      : `📌 待辦清空`,
  ].join("\n");
}

/** 解卦不需要外顯推理，分類也一樣：每一代關掉思考的寫法不同（寫錯是 400）。
 *  抄自產品的 model-params.ts——管家獨立部署，不能 import 產品的檔案。 */
export function noThinking(m: string): { body: Record<string, unknown>; headroom: number } {
  if (/^claude-sonnet-5-5/.test(m)) return { body: { thinking: { type: "between_tools" } }, headroom: 0 };
  if (/^claude-(opus-5-5|fable|mythos)/.test(m)) return { body: { thinking: { type: "adaptive" }, output_config: { effort: "low" } }, headroom: 1500 };
  if (/^claude-((sonnet|opus)-5(?!-\d)|haiku-5)/.test(m)) return { body: { thinking: { type: "disabled" } }, headroom: 0 };
  return { body: {}, headroom: 0 };
}

/* ── 用說的改規則（TG 打一般句子）────────────────────────────
   模型只負責把一句話翻成「規則操作」；這裡驗證每一條，不合格的丟掉，
   觀主按 ✅ 之前什麼都不生效。能做的只有規則：加、刪。改程式的事一律請他回去找 Claude Code。 */

export type RuleOp =
  | { op: "add"; kind: Rule["kind"]; pattern: string; action: Rule["action"]; label?: string | null }
  | { op: "del"; id: number };

export function ruleNlSys(labels: readonly string[]): string {
  return `你是觀主信箱管家的規則助手。觀主用一句話說他想怎麼處理某類信，你把它翻成規則操作。

規則的欄位：
- kind：sender（完整寄件地址，例 news@shopee.tw）／domain（寄件網域，涵蓋子網域，例 shopee.tw）／subject（主旨包含的字）
- action：trash（直接刪）／keep（不刪；有 label 就自動歸檔到 label，沒有就照常推卡問他）／report（一律推給他看）
- label（可省）：歸檔到哪個分類。只能從下面挑，或新開「三月/xx」「五年/xx」「永久/xx」（xx 2～8 字）：
${labels.filter((l) => l !== TODO).join("、")}

刪規則：用 {"op":"del","id":編號}，編號只能從使用者訊息附上的「現有規則」裡找。

判斷原則：
- 說到品牌、公司就用 domain（蝦皮→shopee.tw、104→104.com.tw、LinkedIn→linkedin.com），除非他給了完整地址
- 「不要刪／別刪／要留」＝keep；「都給我看／通知我」＝report；「刪掉／不要再收到」＝trash
- 想取消某條現有規則（例如「104 的信不要再刪了」），就 del 那一條；需要的話再 add 一條新的
- 一句話最多 5 條操作
- 不是規則能做的事（改週報、改排程、改程式、問問題），ops 給空陣列，say 說明「這需要回 Claude Code 對話改程式」
- 看不懂、或不確定是哪個寄件人／網域，ops 給空陣列，say 用一句話反問

只輸出 JSON，不要任何其他字：
{"ops":[{"op":"add","kind":"domain","pattern":"shopee.tw","action":"trash"}],"say":""}`;
}

export function ruleNlPrompt(text: string, rules: Pick<Rule, "id" | "kind" | "pattern" | "action" | "label">[]): string {
  const list = rules.slice(0, 200).map((r) => `#${r.id} ${r.kind} ${r.pattern} → ${r.action}${r.label ? ` [${r.label}]` : ""}`).join("\n");
  return `【觀主說】\n${text.slice(0, 500)}\n\n【現有規則】\n${list || "（沒有）"}`;
}

const SENDER_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** 驗證模型給的每一條；不合格的直接丟掉，不讓它出現在確認卡上。 */
export function parseRuleIntent(text: string, labels: readonly string[], ruleIds: Set<number>):
  { ops: RuleOp[]; say: string; newLabels: string[] } {
  const out = { ops: [] as RuleOp[], say: "", newLabels: [] as string[] };
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return out;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]); } catch { return out; }
  out.say = String(j?.say ?? "").slice(0, 200);
  for (const x of (Array.isArray(j?.ops) ? j.ops : []).slice(0, 5) as Record<string, unknown>[]) {
    if (x?.op === "del") {
      const id = Number(x.id);
      if (Number.isInteger(id) && ruleIds.has(id) && !out.ops.some((o) => o.op === "del" && o.id === id)) out.ops.push({ op: "del", id });
      continue;
    }
    if (x?.op !== "add") continue;
    const kind = String(x.kind ?? "");
    const action = String(x.action ?? "");
    let pattern = String(x.pattern ?? "").trim().toLowerCase();
    if (kind === "domain") pattern = pattern.replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!["trash", "keep", "report"].includes(action)) continue;
    if (kind === "sender" ? !SENDER_RE.test(pattern) : kind === "domain" ? !DOMAIN_RE.test(pattern)
      : kind === "subject" ? (pattern.length < 2 || pattern.length > 50) : true) continue;
    let label: string | null = null;
    if (x.label != null && x.label !== "") {
      if (action === "trash") continue;                          // 要刪又要歸檔，自相矛盾
      if (inList(labels, x.label) && x.label !== TODO) label = x.label as string;
      else if (isValidNewLabel(x.label)) { label = x.label as string; if (!out.newLabels.includes(label)) out.newLabels.push(label); }
      else continue;
    }
    out.ops.push({ op: "add", kind: kind as Rule["kind"], pattern: pattern.slice(0, 200), action: action as Rule["action"], label });
  }
  return out;
}

export function describeOp(op: RuleOp, rules: Pick<Rule, "id" | "kind" | "pattern" | "action" | "label">[] = []): string {
  if (op.op === "del") {
    const r = rules.find((x) => x.id === op.id);
    return r ? `➖ 刪除 #${r.id}：${KIND_LABEL[r.kind]} <code>${esc(r.pattern)}</code> → ${ACTION_LABEL[r.action]}${r.label ? `「${esc(r.label)}」` : ""}`
      : `➖ 刪除 #${op.id}`;
  }
  const what = op.action === "keep" && op.label ? `🗂 自動歸檔到「${esc(op.label)}」`
    : op.action === "keep" ? "🛡 不刪（照常推卡問你）"
    : op.action === "report" ? (op.label ? `📌 在整理結果裡告訴你，並自動歸檔到「${esc(op.label)}」` : "📌 一律推卡給你看")
    : "🗑 直接刪";
  return `➕ ${KIND_LABEL[op.kind]} <code>${esc(op.pattern)}</code> → ${what}`;
}

/* ── 日期 ──────────────────────────────────────────────────── */

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
/** 台北的日期字串（YYYY-MM-DD），offset 為往後幾天。 */
export const taipeiDate = (now = Date.now(), offset = 0) => new Date(now + 8 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
export const taipeiHour = (now = Date.now()) => new Date(now + 8 * 3600_000).getUTCHours();
/** 值得記成提醒的日期：今天到兩年內。過去的、離譜的（模型算錯年份）都不收。 */
export function reminderDue(due: string | undefined, today: string): string | null {
  if (!isDate(due)) return null;
  const d = Date.parse(due + "T00:00:00Z"), t = Date.parse(today + "T00:00:00Z");
  return d >= t && d <= t + 730 * 86_400_000 ? due : null;
}

/* ── 到期日提醒 ─────────────────────────────────────────────── */

export type ReminderItem = { id: number; due_date: string; what: string; sender: string | null; subject: string | null };

export function reminderText(today: ReminderItem[], tomorrow: ReminderItem[]): string {
  const line = (r: ReminderItem) => `• <b>${esc(r.what || r.subject || "（未命名）")}</b>` +
    (r.sender ? `\n　<i>${esc(String(r.sender).slice(0, 40))}｜${esc(String(r.subject ?? "").slice(0, 40))}</i>` : "");
  const out = ["⏰ <b>到期提醒</b>"];
  if (today.length) out.push("", `<b>今天（${esc(today[0].due_date.slice(5))}）</b>`, ...today.map(line));
  if (tomorrow.length) out.push("", `<b>明天（${esc(tomorrow[0].due_date.slice(5))}）</b>`, ...tomorrow.map(line));
  out.push("", "<i>處理好了就按下面的鈕，之後不再提醒</i>");
  return out.join("\n");
}

export function upcomingText(items: ReminderItem[], today: string): string {
  if (!items.length) return "📅 接下來沒有記下的到期日。";
  const days = (d: string) => Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
  return ["📅 <b>接下來的到期日</b>", "", ...items.map((r) => {
    const n = days(r.due_date);
    return `${esc(r.due_date.slice(5))}（${n === 0 ? "今天" : n === 1 ? "明天" : `${n} 天後`}）${esc(r.what || r.subject || "")}`;
  })].join("\n");
}

/* ── 客服信 ─────────────────────────────────────────────────── */

/** 寄到客服信箱的信（To／Cc／Delivered-To 任一含客服地址）。這類信永遠不自動刪、不自動歸檔。 */
export const isSupport = (to: string, addr: string) => !!addr && String(to ?? "").toLowerCase().includes(addr.toLowerCase());

export const SUPPORT_CATS: Record<string, string> = {
  bug: "🐞 程式問題", billing: "💳 付款扣款", refund: "↩️ 退款", account: "🔑 帳號登入",
  feature: "💡 建議", praise: "💐 好評", other: "📩 其他",
};

export const SUPPORT_SYS = `你是占卜 App「藏往知來」（幾知觀）的客服助理。產品有網頁、Android App 與 Telegram bot；
用戶可以起卦問事、和三位角色（大師兄、師妹、觀貓）聊天，有靈石點數與「玉牒」月訂閱（問卦／攻略／深度三種）。

讀用戶寄到客服信箱的信，輸出：
- cat：bug／billing／refund／account／feature／praise／other 其一
- urgent：付款出錯、重複扣款、帳號被盜、無法登入、提到要投訴或法律 → true；其餘 false
- platform：用戶在哪裡遇到的：web（網頁）／app（Android App）／tg（Telegram）／unknown（信裡看不出來）
- sum：一句話（30 字內）講用戶遇到什麼、要什麼
- reply：回信草稿，繁體中文，客氣、簡短、具體。規則：
  ・先回應他說的事，不要套話
  ・不承諾退款、補償、修好的時間——寫「我們會確認後回覆您」
  ・需要更多資訊時，具體問要什麼（裝置、時間、截圖、訂單編號）
  ・不提任何內部細節（模型、伺服器、程式）
  ・結尾署名「藏往知來 客服」

只輸出 JSON，不要任何其他字：{"cat":"bug","urgent":false,"platform":"app","sum":"…","reply":"…"}`;

export const PLATFORMS: Record<string, string> = { web: "網頁", app: "App", tg: "Telegram", unknown: "不明" };

export type SupportVerdict = { cat: string; urgent: boolean; platform: string; sum: string; reply: string };

export function parseSupport(text: string): SupportVerdict | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const reply = String(j?.reply ?? "").trim();
    if (!reply) return null;
    return { cat: j?.cat in SUPPORT_CATS ? j.cat : "other", urgent: j?.urgent === true,
      platform: j?.platform in PLATFORMS ? j.platform : "unknown", sum: String(j?.sum ?? "").slice(0, 80), reply: reply.slice(0, 3000) };
  } catch { return null; }
}

/* ── 帳單與訂閱 ─────────────────────────────────────────────── */

export const CHARGE_SYS = `從扣款通知、帳單或收據裡抓出這一筆的金額。每封信一筆（同一封有多筆時，給最主要的總額）。
kind：product＝「藏往知來」的營運費用（AI API、主機、資料庫、網域、寄信服務、金流手續費、App 上架費，例：Anthropic API、Supabase、Cloudflare、Google Cloud、Resend、綠界）；
      personal＝觀主個人的消費與訂閱（影音、音樂、AI 聊天訂閱、雲端空間、購物、水電、信用卡帳單）。
vendor：商家短名（例 Anthropic、Cloudflare、Spotify、ChatGPT、中信信用卡）。
currency：TWD、USD、JPY…；amount：數字（不含符號與千分位）。
sub：這是固定週期的訂閱或月費 → true。
抓不到金額的那封，amount 給 null。

只輸出 JSON 陣列，不要任何其他字：[{"i":0,"vendor":"Anthropic","currency":"USD","amount":12.5,"kind":"product","sub":false}, …]`;

export type Charge = { vendor: string; currency: string; amount: number; kind: "product" | "personal"; sub: boolean };

export function parseCharges(text: string, n: number): (Charge | null)[] {
  const out: (Charge | null)[] = Array(n).fill(null);
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return out;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return out; }
  for (const x of (Array.isArray(arr) ? arr : []) as Record<string, unknown>[]) {
    const i = Number(x?.i), amount = Number(x?.amount);
    if (!Number.isInteger(i) || i < 0 || i >= n || x?.amount == null || !isFinite(amount) || amount <= 0 || amount > 10_000_000) continue;
    const currency = String(x?.currency ?? "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) continue;
    out[i] = { vendor: String(x?.vendor ?? "?").slice(0, 40), currency, amount, kind: x?.kind === "product" ? "product" : "personal", sub: x?.sub === true };
  }
  return out;
}

/** 換成台幣：TWD 照原值，其他用設定的匯率（沒設的幣別回 null，報表裡另列原幣）。 */
export function toTwd(c: { currency: string; amount: number }, rates: Record<string, number>): number | null {
  if (c.currency === "TWD") return c.amount;
  const r = rates[c.currency];
  return r ? Math.round(c.amount * r) : null;
}

export type ChargeRow = { vendor: string; currency: string; amount: number; twd: number | null; kind: "product" | "personal"; sub: boolean };

/** 月報：分產品／個人，依商家加總，跟上個月比；暴增（>50% 且多 NT$100 以上）標 ⚠️。 */
export function monthlyText(month: string, cur: ChargeRow[], prev: ChargeRow[]): string {
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  const group = (rows: ChargeRow[], kind: string) => {
    const g = new Map<string, { twd: number; count: number; sub: boolean; foreign: string[] }>();
    for (const r of rows.filter((x) => x.kind === kind)) {
      const e = g.get(r.vendor) ?? { twd: 0, count: 0, sub: false, foreign: [] };
      e.count++; e.sub ||= r.sub;
      if (r.twd != null) e.twd += r.twd; else e.foreign.push(`${r.currency} ${r.amount}`);
      g.set(r.vendor, e);
    }
    return g;
  };
  const lines = [`💳 <b>${esc(month)} 帳單與訂閱</b>`, `<i>從信箱裡的扣款通知與收據整理；沒有寄信的扣款不會在這裡</i>`];
  for (const [kind, title] of [["product", "🏮 藏往知來營運"], ["personal", "👤 個人"]] as const) {
    const g = group(cur, kind), pg = group(prev, kind);
    const total = [...g.values()].reduce((a, e) => a + e.twd, 0), ptotal = [...pg.values()].reduce((a, e) => a + e.twd, 0);
    lines.push("", `<b>${title}</b>　NT$ ${n(total)}${ptotal ? `（上月 ${n(ptotal)}）` : ""}`);
    if (!g.size) { lines.push("（沒有）"); continue; }
    for (const [v, e] of [...g.entries()].sort((a, b) => b[1].twd - a[1].twd)) {
      const p = pg.get(v)?.twd ?? 0;
      const spike = p > 0 && e.twd > p * 1.5 && e.twd - p >= 100;
      lines.push(`${spike ? "⚠️ " : ""}${esc(v)}${e.sub ? "（訂閱）" : ""}　NT$ ${n(e.twd)}${e.count > 1 ? ` ×${e.count}` : ""}` +
        (e.foreign.length ? `　＋${esc(e.foreign.join("、"))}` : "") + (spike ? `　上月 ${n(p)}` : ""));
    }
  }
  const subs = [...new Set(cur.filter((r) => r.sub && r.kind === "personal").map((r) => r.vendor))];
  if (subs.length) lines.push("", `🔁 個人訂閱 ${subs.length} 個：${subs.map(esc).join("、")}`);
  return lines.join("\n");
}

/* ── 政府消息（航空城、客運園區）───────────────────────────── */

export const NEWS_DOMAINS = ["gov.tw", "taoyuan-airport.com"];

export function newsSys(topics: string): string {
  return `你幫觀主追蹤政府公告。用網路搜尋找最近 10 天內，下列主題在政府網站（gov.tw，以及桃園國際機場公司）上的新公告、新聞稿、公聽會、都市計畫變更、區段徵收、標案、工程進度：
${topics}

觀主關心的是：會影響房價、交通、入住與周邊建設的實際進展。純活動宣傳、首長行程、與主題無關的不要。
每則：title（20 字內）、date（YYYY-MM-DD，查不到就空字串）、url（政府網站上的原始網址）、sum（40 字內說發生什麼、對觀主有什麼影響）。
沒有新的就給空陣列，不要湊數。

只輸出 JSON 陣列，不要任何其他字：[{"title":"…","date":"2026-10-15","url":"https://…","sum":"…"}]`;
}

export type NewsItem = { title: string; date: string; url: string; sum: string };

export function parseNews(text: string): NewsItem[] {
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).map((x: Record<string, unknown>) => ({
      title: String(x?.title ?? "").slice(0, 60), date: isDate(x?.date) ? x.date as string : "",
      url: String(x?.url ?? ""), sum: String(x?.sum ?? "").slice(0, 120),
    })).filter((x) => x.title && /^https:\/\/[^\s]+$/.test(x.url) &&
      NEWS_DOMAINS.some((d) => { try { const h = new URL(x.url).hostname; return h === d || h.endsWith("." + d); } catch { return false; } }))
      .slice(0, 12);
  } catch { return []; }
}

export function newsText(items: NewsItem[]): string {
  if (!items.length) return "🛫 <b>航空城・客運園區</b>：近期政府網站沒有新公告。";
  return ["🛫 <b>航空城・客運園區 政府消息</b>", "",
    ...items.map((x) => `• <a href="${esc(x.url)}">${esc(x.title)}</a>${x.date ? `（${esc(x.date.slice(5))}）` : ""}\n　${esc(x.sum)}`)].join("\n");
}

/* ── 客服紀錄表（Google 試算表）─────────────────────────────
   資料庫 mailbot_tickets 是正本，試算表是給觀主看、給 Claude 查的副本。
   「已排除」是觀主在表上勾的——Claude 查問題時只讀沒勾的列，查過的不重查。 */

export const TICKET_HEADERS = ["編號", "收到時間", "類別", "平台", "急", "用戶", "主旨", "摘要", "Gmail", "已排除", "備註"];
export const TICKET_DONE_COL = 9;   // 「已排除」在第 10 欄（0 起算 9）＝ J 欄

export type Ticket = {
  id: number; received_at: string; cat: string; platform: string; urgent: boolean;
  sender: string; subject: string; summary: string; thread_id: string;
};

export const ticketNo = (id: number) => `T-${String(id).padStart(4, "0")}`;

/** 一張單 → 試算表的一列。時間用台北；已排除給 FALSE（表上是勾選框）；公式字元開頭的一律加 ' 擋掉，免得用戶信裡的「=…」被當成公式。 */
export function ticketRow(t: Ticket): (string | boolean)[] {
  const safe = (v: string) => /^[=+\-@]/.test(v) ? "'" + v : v;
  const at = new Date(Date.parse(t.received_at) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  return [
    ticketNo(t.id), at, (SUPPORT_CATS[t.cat] ?? t.cat).replace(/^\S+\s/, ""), PLATFORMS[t.platform] ?? t.platform,
    t.urgent ? "急" : "", safe(t.sender), safe(t.subject), safe(t.summary),
    `https://mail.google.com/mail/u/0/#inbox/${t.thread_id}`, false, "",
  ];
}

/** 表上 A～「已排除」欄讀回來 → 還沒排除幾件。只算編號是 T- 開頭的列：
 *  標題列、空列、觀主自己加的筆記列都不算。 */
export function countOpen(rows: unknown[][]): { open: number; total: number } {
  const tickets = rows.filter((r) => /^T-\d+$/.test(String(r?.[0] ?? "")));
  const done = tickets.filter((r) => String(r?.[TICKET_DONE_COL] ?? "").toUpperCase() === "TRUE").length;
  return { open: tickets.length - done, total: tickets.length };
}
