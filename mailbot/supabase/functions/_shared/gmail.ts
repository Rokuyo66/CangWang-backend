// _shared/gmail.ts — 觀主信箱的最小 Gmail API 客戶端（只用到：列信、讀標頭、丟垃圾桶）
//
// 授權走 OAuth refresh token（一次性在本機換好，存成 secret），流程見 dev/MAIL-BUTLER.md。
// scope 只要 gmail.modify：讀、改標籤、丟垃圾桶都夠，**刪不了永久**——這是刻意的。
// 丟進垃圾桶的信 Gmail 30 天後自動清掉，空間一樣會回來；錯刪的話 30 天內還撿得回來。
// 要「立刻永久刪」得拿 https://mail.google.com/ 全權 scope，一把 token 外洩就是整個信箱，不值得。

const CLIENT_ID = Deno.env.get("GMAIL_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET") ?? "";
const REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const gmailConfigured = () => !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  // invalid_grant 最常見的原因：OAuth 同意畫面還在「測試中」，refresh token 7 天就失效。見 MAIL-BUTLER.md 第 1 步
  if (!res.ok || !j.access_token) throw new Error(`gmail token ${res.status} ${j.error ?? ""} ${j.error_description ?? ""}`.trim());
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in ?? 3600) * 1000) };
  return cached.token;
}

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`gmail ${path.split("?")[0]} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

export type MailMeta = {
  id: string; threadId: string;
  from: string; subject: string; snippet: string;
  labels: string[];
  listUnsubscribe: boolean;
  receivedAt: string;
  sizeEstimate: number;
  to: string;          // To＋Cc＋Delivered-To 串起來，判斷是不是寄到客服信箱
  messageId: string;   // 原信的 Message-ID，回信草稿要接在同一串
};

/** 列出符合 Gmail 搜尋語法的信 id（最多 max 封）。 */
export async function listIds(q: string, max = 50): Promise<string[]> {
  const ids: string[] = [];
  let page = "";
  while (ids.length < max) {
    const j = await call(`/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(100, max - ids.length)}${page ? `&pageToken=${page}` : ""}`);
    for (const m of j?.messages ?? []) ids.push(m.id);
    page = j?.nextPageToken ?? "";
    if (!page) break;
  }
  return ids;
}

/** 只拿標頭與摘要，不拿內文——分類用不到內文，也不該讀。內文只在三種情況讀（見 getBody）。 */
export async function getMeta(id: string): Promise<MailMeta> {
  const hs = ["From", "Subject", "List-Unsubscribe", "To", "Cc", "Delivered-To", "Message-ID"];
  const j = await call(`/messages/${id}?format=metadata&${hs.map((x) => `metadataHeaders=${x}`).join("&")}`);
  const h = (name: string) =>
    String((j.payload?.headers ?? []).find((x: { name: string }) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "");
  return {
    id: j.id, threadId: j.threadId,
    from: h("From"), subject: h("Subject"),
    snippet: decodeEntities(String(j.snippet ?? "")),
    labels: j.labelIds ?? [],
    listUnsubscribe: !!h("List-Unsubscribe"),
    receivedAt: new Date(Number(j.internalDate ?? Date.now())).toISOString(),
    sizeEstimate: Number(j.sizeEstimate ?? 0),
    to: [h("To"), h("Cc"), h("Delivered-To")].filter(Boolean).join(", "),
    messageId: h("Message-ID"),
  };
}

const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
const b64urlEncode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 讀內文（純文字，截到 max 字）。只用在三種信：客服來信（要寫回信草稿）、
 *  帳單收據（要抓金額）——其餘一律只看標頭與摘要。 */
export async function getBody(id: string, max = 4000): Promise<string> {
  const j = await call(`/messages/${id}?format=full`);
  let plain = "", html = "";
  // deno-lint-ignore no-explicit-any
  const walk = (p: any) => {
    if (!p) return;
    const data = p.body?.data ? b64urlDecode(p.body.data) : "";
    if (p.mimeType === "text/plain" && !plain) plain = data;
    else if (p.mimeType === "text/html" && !html) html = data;
    for (const c of p.parts ?? []) walk(c);
  };
  walk(j.payload);
  const text = plain || html
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, max);
}

const mimeWord = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

/** 在同一串信裡建一封回信草稿。只建草稿、不寄——送出的永遠是觀主自己。 */
export async function createReplyDraft(p: { threadId: string; to: string; subject: string; inReplyTo: string; body: string; from?: string }): Promise<string> {
  const subject = /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`;
  const headers = [
    ...(p.from ? [`From: ${p.from}`] : []),
    `To: ${p.to}`,
    `Subject: ${mimeWord(subject)}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const raw = b64urlEncode(headers.join("\r\n") + "\r\n\r\n" + p.body);
  const j = await call(`/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, threadId: p.threadId } }) });
  return String(j?.id ?? "");
}

export async function trash(id: string): Promise<void> {
  await call(`/messages/${id}/trash`, { method: "POST" });
}

export async function untrash(id: string): Promise<void> {
  await call(`/messages/${id}/untrash`, { method: "POST" });
}

/** 標籤名稱 → id。觀主在 Gmail 改名或新增標籤時，下一次叫起來就會讀到新的。 */
export async function labelIds(): Promise<Map<string, string>> {
  const j = await call(`/labels`);
  return new Map((j?.labels ?? []).map((l: { name: string; id: string }) => [l.name, l.id]));
}

export async function addLabel(id: string, labelId: string): Promise<void> {
  await modify(id, [labelId], []);
}

/** 加／拿標籤。系統標籤也走這裡：拿掉 INBOX＝歸檔、拿掉 UNREAD＝標已讀。 */
export async function modify(id: string, add: string[], remove: string[]): Promise<void> {
  await call(`/messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });
}

/** 歸檔：貼標籤、移出收件匣、標已讀——收件匣清零與左欄不出現未讀，都靠這一步。 */
export const fileAway = (id: string, labelId: string) => modify(id, [labelId], ["INBOX", "UNREAD"]);

/** 開新標籤（觀主在 TG 按「🆕 新分類」時）。已存在就回現有的 id。 */
export async function ensureLabel(name: string, known?: Map<string, string>): Promise<string> {
  const map = known ?? await labelIds();
  const hit = map.get(name);
  if (hit) return hit;
  const j = await call(`/labels`, {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  map.set(name, j.id);
  return j.id;
}

/** 收到的時間（毫秒）。算「待辦最舊放了幾天」用。 */
export async function receivedAt(id: string): Promise<number> {
  const j = await call(`/messages/${id}?format=minimal`);
  return Number(j?.internalDate ?? Date.now());
}

const decodeEntities = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* ── Google 試算表（客服紀錄表）─────────────────────────────
   同一把 OAuth token，多一個 scope：https://www.googleapis.com/auth/drive.file
   ——只碰「管家自己建立的檔案」，讀不到觀主雲端硬碟裡的任何其他東西。
   授權步驟見 mailbot/README.md「客服紀錄表」。 */

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

async function gcall(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`sheets ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 建一份新試算表：標題列粗體、凍結。回 { id, url, sheetId }。
 *  勾選框不在這裡一次套整欄：套上去的空格子會變成 FALSE，Google 就把那幾千列都當成資料——
 *  計數會錯、新的列還會被接到最底下。勾選框改由 appendRows 只套在剛寫進去的那幾列。 */
export async function createSheet(title: string, headers: string[]): Promise<{ id: string; url: string; sheetId: number }> {
  const j = await gcall(SHEETS, { method: "POST", body: JSON.stringify({
    properties: { title, locale: "zh_TW", timeZone: "Asia/Taipei" },
    sheets: [{ properties: { title: "客服", gridProperties: { frozenRowCount: 1 } } }],
  }) });
  const id = j.spreadsheetId as string, sheetId = j.sheets?.[0]?.properties?.sheetId ?? 0;
  await gcall(`${SHEETS}/${id}/values/${encodeURIComponent("客服!A1")}?valueInputOption=RAW`, {
    method: "PUT", body: JSON.stringify({ values: [headers] }),
  });
  await gcall(`${SHEETS}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
  ] }) });
  return { id, url: j.spreadsheetUrl as string, sheetId };
}

/** 接在最後一列之後，並把 checkboxCol 那一欄（只限剛寫的這幾列）設成勾選框。 */
export async function appendRows(id: string, sheetId: number, rows: (string | boolean)[][], checkboxCol: number): Promise<void> {
  const j = await gcall(`${SHEETS}/${id}/values/${encodeURIComponent("客服!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST", body: JSON.stringify({ values: rows }),
  });
  // updatedRange 長這樣：'客服'!A5:K7 → 第 5～7 列
  const m = /![A-Z]+(\d+):[A-Z]+(\d+)$/.exec(String(j?.updates?.updatedRange ?? ""));
  if (!m) return;
  await gcall(`${SHEETS}/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [
    { setDataValidation: { range: { sheetId, startRowIndex: Number(m[1]) - 1, endRowIndex: Number(m[2]), startColumnIndex: checkboxCol, endColumnIndex: checkboxCol + 1 },
      rule: { condition: { type: "BOOLEAN" }, showCustomUi: true } } },
  ] }) });
}

export async function readRange(id: string, range: string): Promise<unknown[][]> {
  const j = await gcall(`${SHEETS}/${id}/values/${encodeURIComponent(range)}`);
  return (j.values ?? []) as unknown[][];
}
