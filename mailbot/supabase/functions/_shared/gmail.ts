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

/** 只拿標頭與摘要，不拿內文——管家判斷用不到內文，也不該讀。 */
export async function getMeta(id: string): Promise<MailMeta> {
  const j = await call(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`);
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
  };
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
