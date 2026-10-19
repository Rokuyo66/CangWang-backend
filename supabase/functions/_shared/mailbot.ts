// _shared/mailbot.ts — 信箱管家的判斷與文案（純函式，不碰網路、不碰 Deno.env，node 測得到）
//
// 一封信的去處只有四種：
//   report → 推到 TG 給觀主看（需要知道的）
//   trash  → 丟垃圾桶（Gmail 30 天後自動清，空間回來）
//   keep   → 不動、不吵（收據、通知類，留著備查但不必看）
//   ask    → 拿不準，推到 TG 附按鈕問；按下去順便長出一條規則，下次就不問了
//
// 【順序】觀主的規則 > 守門關鍵字 > AI 判斷。
// 【鐵則】寧可多問一封，不可錯刪一封。AI 說刪但信心不夠、或不是廣告型的信，一律改問。
//         守門關鍵字（銀行、帳單、驗證碼、政府、合約…）命中的信，AI 再怎麼說刪也只能問。

export type Decision = "report" | "trash" | "keep" | "ask";
export type Rule = { id: number; kind: "sender" | "domain" | "subject"; pattern: string; action: "trash" | "report" | "keep"; label?: string | null };
export type AiVerdict = { v: Decision; c: number; why: string; sum: string; lb?: string };

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
export const isLabel = (s: unknown): s is string => typeof s === "string" && (LABELS as readonly string[]).includes(s);

/** 到期清理：Gmail 搜尋語法裡，巢狀標籤的「/」寫成「-」。 */
export const SWEEP = [
  { q: "label:三月-水電瓦斯 older_than:3m", label: "三月/水電瓦斯" },
  { q: "label:三月-保險通知 older_than:3m", label: "三月/保險通知" },
  { q: "label:三月-帳單繳費 older_than:3m", label: "三月/帳單繳費" },
  { q: "label:五年-外包收入 older_than:5y", label: "五年/外包收入" },
  { q: "label:五年-保固憑證 older_than:5y", label: "五年/保固憑證" },
  { q: "label:五年-產品營運 older_than:5y", label: "五年/產品營運" },
  { q: "label:五年-錄取通知 older_than:5y", label: "五年/錄取通知" },
] as const;
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
export function decide(meta: Meta, rule: Rule | null, ai: AiVerdict | null):
  { decision: Decision; source: "rule" | "ai" | "guard"; reason: string; label?: string } | null {
  const d = decideCore(meta, rule, ai);
  if (!d || (d.decision !== "report" && d.decision !== "keep")) return d;
  // 留下來的信才貼期限標籤；規則指定的優先，其次 AI 建議的
  const label = isLabel(rule?.label) ? rule!.label! : isLabel(ai?.lb) ? ai!.lb : undefined;
  return label ? { ...d, label } : d;
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

export const CLASSIFY_SYS = `你是「觀主」的信箱管家。觀主是台灣的遊戲 UI 設計師，也是占卜 App「藏往知來／幾知觀」的開發者兼營運者，另外在追蹤桃園航空城的建案。

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
一次性驗證碼、登入通知、物流進度這類用完即棄的，不給標籤。

只輸出 JSON 陣列，不要任何其他字：[{"i":0,"v":"report","c":0.9,"why":"…","sum":"…","lb":"五年/產品營運"}, …]`;

export function classifyPrompt(items: { from: string; subject: string; snippet: string }[]): string {
  return items.map((m, i) =>
    `#${i}\n寄件人：${m.from.slice(0, 120)}\n主旨：${m.subject.slice(0, 200)}\n摘要：${m.snippet.slice(0, 300)}`).join("\n\n");
}

/** 容錯解析：模型偶爾包 ```json 或多話。缺的、壞的那一封回 null（下一輪重判）。 */
export function parseClassify(text: string, n: number): (AiVerdict | null)[] {
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
    if (isLabel(x?.lb)) out[i]!.lb = x.lb as string;
  }
  return out;
}

/* ── TG 按鈕 ─────────────────────────────────────────────── */
// callback_data 上限 64 bytes：mb:<動作>:<mailbot_seen.id>
//   t 刪這封   T 刪＋此寄件人以後都刪   D 刪＋此網域以後都刪
//   k 留這封   K 留＋此寄件人以後一律回報   u 從垃圾桶救回（自動刪錯時用）
export type MbOp = "t" | "T" | "D" | "k" | "K" | "u";
export const mbCallback = (op: MbOp, id: number) => `mb:${op}:${id}`;
export function parseMbCallback(data: string): { op: MbOp; id: number } | null {
  const m = /^mb:([tTDkKu]):(\d{1,15})$/.exec(data ?? "");
  return m ? { op: m[1] as MbOp, id: Number(m[2]) } : null;
}

export function askButtons(id: number) {
  return [
    [{ text: "🗑 刪", callback_data: mbCallback("t", id) }, { text: "📥 留", callback_data: mbCallback("k", id) }],
    [{ text: "🗑 這寄件人以後都刪", callback_data: mbCallback("T", id) }, { text: "🗑 整個網域都刪", callback_data: mbCallback("D", id) }],
    [{ text: "📌 這寄件人以後都報給我", callback_data: mbCallback("K", id) }],
  ];
}

/* ── 文案 ────────────────────────────────────────────────── */

export function askText(m: { from: string; subject: string; snippet: string; reason: string }): string {
  const f = parseFrom(m.from);
  return `❓ <b>這封要刪嗎？</b>\n` +
    `<b>${esc(f.name)}</b>　<code>${esc(f.email)}</code>\n` +
    `${esc(m.subject || "（無主旨）")}\n` +
    `<i>${esc(m.snippet.slice(0, 120))}${m.snippet.length > 120 ? "…" : ""}</i>` +
    (m.reason ? `\n\n🤖 ${esc(m.reason)}` : "");
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
  if (c.kept) tail.push(`📥 留存不報 ${c.kept} 封`);
  const lab = Object.entries(c.labeled ?? {}).filter(([, n]) => n > 0);
  if (lab.length) tail.push(`🏷 歸檔：${lab.map(([k, n]) => `${esc(k)} ${n}`).join("、")}`);
  if (c.asked) tail.push(`❓ 待你決定 ${c.asked} 封（見上方各則）`);
  if (c.skipped) tail.push(`⏳ ${c.skipped} 封 AI 沒判出來，下一輪再看`);
  if (tail.length) lines.push("", ...tail);
  lines.push("", `<i>刪錯了：垃圾桶 30 天內都撿得回來；/mailrules 看規則</i>`);
  return lines.join("\n");
}

/* ── 週報 ────────────────────────────────────────────────── */

type Week = Record<string, number>;
export type WeeklyStats = {
  from: string; to: string; cur: Week; prv: Week; retained: number;
  casts_by_char: Record<string, number>; casts_by_cat: Record<string, number>;
  by_day: Record<string, number>;
  mail: { trashed: number; reported: number; open: number; rules: number };
  // 以下由 mail-butler 在發週報當下從 Gmail 算出來（不在 SQL 裡）
  sweep?: { swept: number; byLabel: Record<string, number>; todo: number; todoOldestDays: number | null };
};

/** 本週 vs 上週：▲12%／▼5%／持平／新（上週 0）。 */
export function delta(cur: number, prv: number): string {
  if (!prv) return cur ? "（新）" : "";
  const p = Math.round(((cur - prv) / prv) * 100);
  return p === 0 ? "（持平）" : p > 0 ? `（▲${p}%）` : `（▼${-p}%）`;
}

const CHAR_LABELS: Record<string, string> = { daoshi_m: "大師兄", daoshi_f: "師妹", lingshou: "觀貓" };

export function weeklyText(s: WeeklyStats): string {
  const n = (v: unknown) => Number(v ?? 0).toLocaleString("en-US");
  const c = s.cur ?? {}, p = s.prv ?? {};
  const row = (label: string, k: string) => `${label} <b>${n(c[k])}</b>${delta(Number(c[k] ?? 0), Number(p[k] ?? 0))}`;
  const retainBase = Number(p.active_users ?? 0);
  const retain = retainBase ? `${Math.round((s.retained / retainBase) * 100)}%（${s.retained}/${retainBase}）` : "—";
  const hit = Number(c.verdicts ?? 0) ? `${Math.round((Number(c.verdict_hit ?? 0) / Number(c.verdicts)) * 100)}%` : "—";
  const margin = Number(c.revenue_twd ?? 0) - Number(c.ai_twd ?? 0);
  const days = Object.entries(s.by_day ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const peak = days.reduce((best, d) => (d[1] > best[1] ? d : best), ["", -1] as [string, number]);
  const chars = Object.entries(s.casts_by_char ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(CHAR_LABELS[k] ?? k)} ${n(v)}`).join("　") || "—";
  const cats = Object.entries(s.casts_by_cat ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} ${n(v)}`).join("　") || "—";

  return [
    `📊 <b>藏往知來・週報</b>　${esc(s.from)} ～ ${esc(s.to)}`,
    `<i>括號內為與前一週相比</i>`,
    "",
    `<b>👥 用戶</b>`,
    `${row("新註冊", "new_users")}　${row("週活躍", "active_users")}`,
    `留存（上週活躍、本週回來）${retain}`,
    peak[1] >= 0 ? `最熱的一天 ${esc(peak[0].slice(5))}（${n(peak[1])} 人）` : null,
    "",
    `<b>🔮 使用</b>`,
    `${row("起卦", "casts")}（網頁／App ${n(c.casts_web)}）　${row("追問", "followups")}`,
    `${row("閒聊", "chats")}`,
    `角色：${chars}`,
    `問事：${cats}`,
    `回評 ${n(c.verdicts)} 則，準 ${hit}`,
    "",
    `<b>💰 營收與成本</b>`,
    `${row("收入 NT$", "revenue_twd")}（${n(c.payments)} 筆扣款）`,
    `${row("AI 成本 NT$", "ai_twd")}`,
    `毛利 NT$ <b>${n(margin)}</b>　靈石消耗 ${n(c.lingshi_spent)}`,
    "",
    `<b>📬 信箱管家</b>　刪 ${n(s.mail?.trashed)}　回報 ${n(s.mail?.reported)}　待決 ${n(s.mail?.open)}　規則 ${n(s.mail?.rules)} 條`,
    s.sweep && s.sweep.swept
      ? `🧹 到期清理 ${n(s.sweep.swept)} 封：` + Object.entries(s.sweep.byLabel).filter(([, v]) => v > 0).map(([k, v]) => `${esc(k)} ${n(v)}`).join("、")
      : null,
    s.sweep && s.sweep.todo
      ? `📌 待辦還有 ${n(s.sweep.todo)} 封` + (s.sweep.todoOldestDays !== null ? `，最舊的放了 ${s.sweep.todoOldestDays} 天` : "")
      : null,
  ].filter((l) => l !== null).join("\n");
}
