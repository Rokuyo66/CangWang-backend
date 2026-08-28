// interpret/index.ts — HTTP 端點
//  · 網頁公開層：Authorization: Bearer <Supabase Auth JWT>（瀏覽器用，安全）
//  · TG/Mini App 後端內部呼叫：x-internal-key（沿用，向後相容）
import { createClient } from "npm:@supabase/supabase-js@2";
import { castAndInterpret, followupInterpret, deepenCast, commentCast } from "../_shared/pipeline.ts";
import { dailyFortune } from "../_shared/fortune.ts";
import { jieqiOf } from "../_shared/jieqi.ts";
import { chat, COST_CHAT, chatQuotaOf, FAVOR_CAP, memoryQuotaOf, pinQuotaOf } from "../_shared/chat.ts";
import {
  computeCollection, claimedRewards, rewardState, CHAR_REWARDS, PLAYER_REWARDS,
} from "../_shared/collection.ts";
import { refineQuestion } from "../_shared/qrefine.ts";
import { planOf, followupFreeLeft, castFreeLeft, guideSeenOf, markGuideSeen, PLAN_FOLLOWUPS, PLAN_CASTS, COST_FOLLOWUP, COST_EXTRA_CAST } from "../_shared/services.ts";
import { listCases, startCase, caseStateOf, actOnCase, keepRun, deleteRun, type CaseResult } from "../_shared/case-run.ts";
import { listEvents, openEvent } from "../_shared/events.ts";
import {
  timeline, threadDetail, openThread, attachCast, setThreadStatus, deleteThread,
  suggestThread, replyToNote, markNotesRead, monthlyReview, monthlyIndex, threadQuotaOf,
} from "../_shared/xinji.ts";
import { callInterpret, logUsage } from "../_shared/services.ts";
import {
  stickerShelf, buyPack, placeSticker, moveSticker, removeSticker, stickerLayout, layoutOf,
} from "../_shared/stickers.ts";
import {
  voiceKeep, voiceList, voiceDelete, clipQuotaOf,
} from "../_shared/voice.ts";
import { ledgerDetails, groupLedger, type LedgerRow } from "../_shared/ledger.ts";
import { castTexts, speakCast, speakChat, ttsQuota } from "../_shared/tts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRANT_REGISTER = 50;
const COST_MEND = 10;                       // 斷簽補簽費用（靈石），可調
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? ""; // 觀主內部 user_id：可刪任意廣場貼文
const LEDGER_WINDOW = 600;                  // 收支查詢一次最多撈幾筆流水（分組後一列可代表數十筆）
const POST_DAILY_LIMIT = 5;                 // 每日發文上限（沿用 free_quota）
const POST_HOT_THRESHOLD = 25;              // 熱門門檻：達此讚數一次性發獎
const POST_HOT_REWARD = 10;                 // 熱門獎勵靈石（一次性）
const COMMENT_DAILY_LIMIT = 30;             // 每日回文上限（防灌水）
const COMMENT_MAX = 300;                    // 回文字數上限
const COMMENT_HOT_THRESHOLD = 10;           // 回文熱門門檻：達此讚數一次性發獎
const COMMENT_HOT_REWARD = 5;               // 回文熱門獎勵靈石（一次性）
const CHAT_EXCERPT_MAX = 800;               // 閒聊節錄總字數上限（前端同值提示）
const CHAT_EXCERPT_MSGS = 30;               // 閒聊節錄最多則數
// 分享卦快照時剝掉初步解卦結尾的制式引導語（「想看完整卦理依據，點下方展開。」及變體）
// ——那是站內按鈕的導引，貼到廣場沒有按鈕可點，照搬會很蠢
function stripReadingGuide(reading: string): string {
  // 只剝引導語本身（含少量變體），不吃同一行前面的正文
  return String(reading ?? "").replace(/[想若欲]?看?完整卦理(?:依據)?[，,]?\s*點下方展開[。.]?\s*$/, "").trimEnd();
}
// 手動排盤自填占時：{y,m,d,hour}。任何欄位不合法即回 undefined（後端退回用當下台北時，向後相容）
function parseCastDate(cd: unknown): { y: number; m: number; d: number; hour: number | null } | undefined {
  if (!cd || typeof cd !== "object") return undefined;
  const { y, m, d, hour } = cd as Record<string, unknown>;
  const okInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!okInt(y, 1900, 2200) || !okInt(m, 1, 12) || !okInt(d, 1, 31)) return undefined;
  if (hour != null && !okInt(hour, 0, 23)) return undefined;
  return { y: y as number, m: m as number, d: d as number, hour: hour == null ? null : (hour as number) };
}
// 連續簽到 7 日一輪的獎勵 [靈石, 好感]。
// 原本一輪 140 顆（約 600/月），零售價值遠超訂閱月費——簽到就能供養整月的用量，
// 靈石經濟等於自我瓦解，沒人需要買。下修到一輪 66 顆（約 283/月）：
// 仍足以支撐日常追問與換評，但要開完整卦理或大量加卦就得付費。
// 維持單一貨幣（不另立「限定用途靈石」）——兩種貨幣只會生出「這顆為什麼不能用」的客服。
const SIGN_REWARDS: [number, number][] = [[5,0],[5,0],[8,5],[8,0],[10,0],[10,0],[20,10]];
// 可解鎖配色售價（靈石）。零 AI 邊際成本，屬純毛利品項；
// 定價以「簽到月收約 283 顆」為尺，一套約當一個月的簽到量，買得下但要攢。
const THEME_PRICES: Record<string, number> = { bamboo: 260, cinnabar: 260, porcelain: 320 };
const AH_KEYS = ["a","b","c","d","e","f","g","h"];
// 玩家 a~h 頭像解鎖數：註冊解 5，之後每滿 7 次簽到 +1，上限 8
const ahUnlockedCount = (signinTotal: number) => 5 + Math.min(3, Math.floor(signinTotal / 7));
// CORS：瀏覽器跨網域呼叫必需。上線時把 * 改成你的網域。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 卦案服務層的 Result → HTTP。錯誤一律 200＋kind:"err"，與站內既有做法一致
// （前端那支 callInterpret 只有非 2xx 才丟例外，訊息要能顯示就不能走 4xx）。
function caseResult(r: CaseResult): Response {
  return r.ok
    ? Response.json({ kind: "ok", ...r.payload }, { headers: CORS })
    : Response.json({ kind: "err", msg: r.msg }, { headers: CORS });
}

// 網頁 Auth 用戶 → 內部 user_id（鏡像 webhook-tg 的 ensureUser）
async function ensureWebUser(authUserId: string, name?: string): Promise<string> {
  const { data: idt } = await db.from("identities").select("user_id")
    .eq("provider", "web").eq("external_id", authUserId).maybeSingle();
  if (idt) return idt.user_id;
  const { data: prof } = await db.from("profiles").insert({ display_name: name ?? null }).select("id").single();
  await db.from("identities").insert({ provider: "web", external_id: authUserId, user_id: prof!.id });
  await db.rpc("apply_lingshi", { p_user: prof!.id, p_action: "register", p_amount: GRANT_REGISTER });
  return prof!.id;
}

// 驗證 Supabase Auth JWT → 內部 user_id（失敗回 null）
async function userFromJwt(jwt: string): Promise<string | null> {
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  return await ensureWebUser(data.user.id, data.user.email ?? undefined);
}

// App 最低版本。0＝不啟用。調高即刻讓舊版 App 失去「需登入」的功能（排盤、複製、看廣場不受影響）。
// 不寫死在程式裡：要擋哪一版是營運決定，改 env 即可，不必重新部署函式。
const MIN_APP_BUILD = Number(Deno.env.get("MIN_APP_BUILD") ?? "0");

// 觀前石牆：公開回評牆＋整體準驗統計（免認證唯讀；只出評語/卦名/暱稱，不含問事原文）
let wallCache: { t: number; payload: Record<string, unknown> } | null = null;
async function wallResponse(): Promise<Response> {
  // min_app_build 疊在快取外層：門檻是隨時可能調的營運參數，不該被 5 分鐘快取黏住。
  // 前端搭石牆的順風車讀它，不必為了版本檢查另外打一趟。
  if (wallCache && Date.now() - wallCache.t < 300_000) {
    return Response.json({ ...wallCache.payload, min_app_build: MIN_APP_BUILD }, { headers: CORS });
  }
  const stats = { hit: 0, part: 0, miss: 0, total: 0 };
  for (const [k, v] of [["hit", 1], ["part", 2], ["miss", 3]] as const) {
    const { count } = await db.from("feedback").select("cast_id", { count: "exact", head: true }).eq("verdict", v);
    stats[k] = count ?? 0;
  }
  stats.total = stats.hit + stats.part + stats.miss;
  const { data: fbs } = await db.from("feedback")
    .select("cast_id, user_id, verdict, note, answered_at")
    .eq("is_public", true).not("note", "is", null)
    .order("answered_at", { ascending: false }).limit(10);
  const rows = (fbs ?? []).filter((f: { note: string | null }) => String(f.note ?? "").trim());
  // 兩段式查卦名/暱稱（不靠巢狀嵌入，同卦歷做法）
  const castIds = rows.map((f: { cast_id: string }) => f.cast_id);
  const userIds = [...new Set(rows.map((f: { user_id: string }) => f.user_id))];
  const { data: cs } = castIds.length ? await db.from("casts").select("id, gua_ben").in("id", castIds) : { data: [] };
  const { data: ps } = userIds.length ? await db.from("profiles").select("id, display_name").in("id", userIds) : { data: [] };
  const gua = new Map((cs ?? []).map((c: { id: string; gua_ben: string }) => [c.id, c.gua_ben]));
  const names = new Map((ps ?? []).map((p: { id: string; display_name: string | null }) => [p.id, p.display_name]));
  const entries = rows.map((f: { cast_id: string; user_id: string; verdict: number; note: string; answered_at: string | null }) => ({
    note: String(f.note).slice(0, 120),
    verdict: f.verdict,
    gua: gua.get(f.cast_id) ?? "",
    name: names.get(f.user_id) || "護道人",
    date: String(f.answered_at ?? "").slice(0, 10),
  }));
  const payload = { kind: "ok", stats, entries };
  wallCache = { t: Date.now(), payload };
  return Response.json({ ...payload, min_app_build: MIN_APP_BUILD }, { headers: CORS });
}

// 觀前廣場列表（免認證唯讀）：作者暱稱/頭像兩段式查 profiles（不巢狀嵌入，同石牆做法）
// 討論區形式：列表只回標題列所需（標題/作者/頭像/讚/回文數/有無盤面），全文由 post_detail 取
const POST_PAGE = 10;                        // 每頁貼文數（前端數字分頁一頁 10 篇）
const POST_TYPES = ["cast", "thread", "chat_story"];
type PostRow = {
  id: string; user_id: string; type: string; title: string;
  cast_snapshot: { chart?: unknown } | null; chat_snapshot: unknown;
  character_id: string | null; like_count: number; comment_count: number;
  pinned_at: string | null; created_at: string;
};
const POST_LIST_COLS = "id, user_id, type, title, cast_snapshot, chat_snapshot, character_id, like_count, comment_count, pinned_at, created_at";
async function postEntries(rows: PostRow[]) {
  const userIds = [...new Set(rows.map((p) => p.user_id))];
  const { data: ps } = userIds.length
    ? await db.from("profiles").select("id, display_name, selected_avatar, title_tag").in("id", userIds) : { data: [] };
  const profs = new Map((ps ?? []).map((p: { id: string; display_name: string | null; selected_avatar: string | null; title_tag: string | null }) => [p.id, p]));
  return rows.map((p) => ({
    id: p.id, user_id: p.user_id, type: p.type, title: p.title,
    character_id: p.character_id, like_count: p.like_count, comment_count: p.comment_count ?? 0,
    has_chart: !!(p.cast_snapshot && p.cast_snapshot.chart), created_at: p.created_at,
    pinned: !!p.pinned_at,
    name: profs.get(p.user_id)?.display_name || "護道人",
    avatar: profs.get(p.user_id)?.selected_avatar ?? null,
  }));
}
// 列表：分類篩選（type=cast/thread/chat_story，其餘視為全部）＋置頂優先＋數字分頁（回 total 供前端算頁數）
async function postListResponse(sort: unknown, offset: unknown, type: unknown): Promise<Response> {
  const off = Math.max(0, Number(offset) || 0);
  const hot = sort === "hot";
  const typeFilter = POST_TYPES.includes(String(type)) ? String(type) : null;
  let q = db.from("posts").select(POST_LIST_COLS, { count: "exact" });
  if (typeFilter) q = q.eq("type", typeFilter);
  // 置頂永遠優先（不分最新/熱門）；其後才套排序準則
  q = q.order("pinned_at", { ascending: false, nullsFirst: false });
  q = hot
    ? q.order("like_count", { ascending: false }).order("created_at", { ascending: false })
    : q.order("created_at", { ascending: false });
  // 讀失敗要回 err：吞掉錯誤會讓前端把「表不存在／查詢失敗」畫成「尚無貼文」
  const { data: posts, error, count } = await q.range(off, off + POST_PAGE - 1);
  if (error) return Response.json({ kind: "err", msg: "廣場暫時無法載入" }, { headers: CORS });
  const rows = (posts ?? []) as PostRow[];
  const entries = await postEntries(rows);
  return Response.json({ kind: "ok", posts: entries, hasMore: rows.length === POST_PAGE, total: count ?? 0, pageSize: POST_PAGE }, { headers: CORS });
}

// 貼文內頁（免認證唯讀）：全文＋快照＋回文串
async function postDetailResponse(postId: unknown): Promise<Response> {
  const { data: p, error } = await db.from("posts")
    .select("id, user_id, type, title, body, cast_snapshot, chat_snapshot, character_id, like_count, comment_count, pinned_at, created_at")
    .eq("id", String(postId ?? "")).maybeSingle();
  if (error) return Response.json({ kind: "err", msg: "貼文暫時無法載入" }, { headers: CORS });
  if (!p) return Response.json({ kind: "not_found" }, { headers: CORS });
  // 回文依點讚熱度排序，同熱度先到先排
  const { data: cs } = await db.from("post_comments")
    .select("id, user_id, body, like_count, edited_at, created_at").eq("post_id", p.id)
    .order("like_count", { ascending: false }).order("created_at", { ascending: true }).limit(200);
  const comments = cs ?? [];
  const userIds = [...new Set([p.user_id, ...comments.map((c: { user_id: string }) => c.user_id)])];
  const { data: ps } = await db.from("profiles").select("id, display_name, selected_avatar, title_tag").in("id", userIds);
  const profs = new Map((ps ?? []).map((x: { id: string; display_name: string | null; selected_avatar: string | null; title_tag: string | null }) => [x.id, x]));
  const who = (uid: string) => ({ name: profs.get(uid)?.display_name || "護道人", avatar: profs.get(uid)?.selected_avatar ?? null, title_tag: profs.get(uid)?.title_tag ?? null });
  return Response.json({
    kind: "ok",
    post: { ...p, pinned: !!p.pinned_at, cast: p.cast_snapshot ?? null, chat: p.chat_snapshot ?? null, ...who(p.user_id) },
    comments: comments.map((c: { id: string; user_id: string; body: string; edited_at: string | null; created_at: string }) => ({ ...c, ...who(c.user_id) })),
  }, { headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400, headers: CORS }); }

  // 觀前石牆：免認證（放在認證前；唯讀、匿名安全欄位、5 分鐘快取）
  if (body.mode === "wall") return await wallResponse();

  // 觀前廣場列表：免認證唯讀（發文/按讚/刪文仍需登入）。new=最新 hot=熱門，offset 分頁每頁 20
  if (body.mode === "post_list") return await postListResponse(body.sort, body.offset, body.type);

  // 貼文內頁：免認證唯讀（全文＋盤面/閒聊快照＋回文串）
  if (body.mode === "post_detail") return await postDetailResponse(body.post_id);

  // 版本閘門：只擋需登入的功能。到這一行為止的 wall／post_list／post_detail 都已放行，
  // 所以舊版 App 仍可排盤、複製卦象（純本機）與觀看廣場，只是不能登入、不能發言。
  // MIN_APP_BUILD 未設或為 0 時完全不啟用。TG（x-internal-key）沒有版本概念，不受此限。
  if (req.headers.get("authorization") && MIN_APP_BUILD > 0) {
    const b = Number(body.app_build ?? 0);
    if (b < MIN_APP_BUILD) {
      return Response.json({ kind: "app_outdated", min_build: MIN_APP_BUILD, app_build: b }, { headers: CORS });
    }
  }

  // 認證雙軌
  let jwtUserId: string | null = null;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    jwtUserId = await userFromJwt(auth.slice(7));
    if (!jwtUserId) return new Response("unauthorized", { status: 401, headers: CORS });
  } else if (req.headers.get("x-internal-key") !== Deno.env.get("INTERNAL_API_KEY")) {
    return new Response("forbidden", { status: 403, headers: CORS });
  }

  try {
    // 網頁(JWT)路徑：user_id 一律用 JWT 解出的，忽略前端傳的 body.user_id（安全鐵則）
    const uid = jwtUserId ?? body.user_id;
    if (!uid) return new Response("no user", { status: 400, headers: CORS });

    // 查個人狀態：靈石、暱稱、各角色好感/境界、應期未回評數（紅點）
    if (body.mode === "profile") {
      const { data: prof, error: profErr } = await db.from("profiles").select("lingshi, display_name, last_sign_date, selected_avatar, signin_total, claimed_rewards, plaza_unread, last_fortune_date, guide_seen_at, owned_themes, title_tag").eq("id", uid).maybeSingle();
      // 這一列讀不到（欄位對不上、連線壞了）時，下面每一個欄位都會靜靜地退回預設值。
      // 別的欄位退回預設頂多是畫面數字不對，guide_seen_at 退回 null 卻等於「沒看過引導」，
      // 於是讀取失敗會被演成「每次登入都重講一次規矩」。至少要留下一行看得見的紀錄。
      if (profErr) console.error("profile read failed", uid, profErr.message);
      const { data: ucs } = await db.from("user_character").select("character_id, favor, realm, cultivation, avatar").eq("user_id", uid);
      const favors: Record<string, number> = {}, realms: Record<string, string> = {}, cults: Record<string, number> = {}, charAvatars: Record<string, string> = {};
      (ucs ?? []).forEach((u: { character_id: string; favor: number; realm: string; cultivation: number; avatar: string | null }) => {
        favors[u.character_id] = u.favor; realms[u.character_id] = u.realm; cults[u.character_id] = u.cultivation;
        if (u.avatar) charAvatars[u.character_id] = u.avatar;
      });
      const today = new Date().toISOString().slice(0, 10);
      const { data: dues } = await db.from("casts").select("id, due_date, feedback(verdict)")
        .eq("user_id", uid).not("due_date", "is", null).lte("due_date", today);
      const dueUnreviewed = (dues ?? []).filter((c: { feedback: unknown }) => {
        const f = Array.isArray(c.feedback) ? c.feedback[0] : c.feedback;
        return !f || (f as { verdict: number | null })?.verdict == null;
      }).length;
      // 方案先取：免費聊天、起卦、追問三項額度都依方案分級，下面每一段都要用它。
      // （曾經把這行擺在第一個使用點之後，profile 整支因暫時性死區 500，
      //   前端登入後 refreshProfile 失敗、畫面翻不到已登入狀態——宣告必須在最前。）
      const plan = await planOf(db, uid);
      const followFreeLeft = await followupFreeLeft(db, uid, plan);
      // 今日免費卦剩餘：排盤頁的「入觀解卦」要據此標出白揭或償香火。
      // 額度鍵與 billCast 同一把（登入者即 uid），標價才不會與實際扣費打架。
      const castLeft = await castFreeLeft(db, uid, plan);
      // 今日聊天免費剩餘
      const cday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const { data: cq } = await db.from("free_quota").select("used_today, last_reset").eq("key", `chatfree:${uid}:${cday}`).maybeSingle();
      const cused = (cq && cq.last_reset === cday) ? cq.used_today : 0;
      const chatFreeLeft = Math.max(0, chatQuotaOf(plan) - cused);
      const signedToday = prof?.last_sign_date === cday;
      // 收集獎勵待領數（卦曆鈕紅點用）：集滿達成但尚未領取
      const { eligible } = await computeCollection(db, uid);
      const claimedArr = (prof?.claimed_rewards ?? []) as string[];
      const claimableRewards = rewardState(eligible, claimedArr).claimable.length;
      // 廣場未讀：改由 plaza_notices 逐則統計（profiles.plaza_unread 已退場，不再寫入）
      const { count: pnCount } = await db.from("plaza_notices")
        .select("comment_id", { count: "exact", head: true }).eq("user_id", uid);
      const plazaUnreadCount = pnCount ?? 0;
      // 日運：今日是否已抽＋當日節氣句（前端畫每日提醒卡用）
      const fortuneDone = prof?.last_fortune_date === cday;
      // 初次引導：讀不到 profiles 那一列時一律當作看過——寧可少講一次，
      // 也不要因為一次讀取失敗就把七句話重講給早就聽過的人。
      const guideSeen = profErr ? true : await guideSeenOf(db, uid, prof?.guide_seen_at);
      const [fy, fm, fd] = cday.split("-").map(Number);
      // 心跡：導覽紅點與額度標示。兩個 count(head) 而已——為了兩個數字讓前端
      // 在每次開 App 時多打一支 xinji_timeline，是把便宜的東西做貴。
      const { count: xjOpen } = await db.from("threads")
        .select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "open");
      const { count: xjNotes } = await db.from("thread_notes")
        .select("id", { count: "exact", head: true }).eq("user_id", uid).is("read_at", null);
      return Response.json({ kind: "ok", uid, isAdmin: !!ADMIN_USER_ID && uid === ADMIN_USER_ID, lingshi: prof?.lingshi ?? 0, display_name: prof?.display_name ?? null, favors, realms, cults, charAvatars, dueUnreviewed, chatFreeLeft, chatCost: COST_CHAT, signedToday, selected_avatar: prof?.selected_avatar ?? null, ahUnlocked: ahUnlockedCount(prof?.signin_total ?? 0), claimableRewards, claimedRewards: claimedArr, plazaUnread: plazaUnreadCount, fortuneDone, jieqi: jieqiOf(fy, fm, fd),
        plan, followFreeLeft, followFreePerDay: PLAN_FOLLOWUPS[plan] ?? PLAN_FOLLOWUPS.free,
        castFreePerDay: PLAN_CASTS[plan] ?? PLAN_CASTS.free, castFreeLeft: castLeft, castCost: COST_EXTRA_CAST,
        followupCost: COST_FOLLOWUP,
        chatFreePerDay: chatQuotaOf(plan), guideSeen,
        ownedThemes: (prof?.owned_themes ?? []) as string[], themePrices: THEME_PRICES,
        xinjiOpen: xjOpen ?? 0, xinjiMax: threadQuotaOf(plan), xinjiUnread: xjNotes ?? 0,
        title_tag: prof?.title_tag ?? null }, { headers: CORS });
    }

    // 初次問事引導看完：記在帳號，換裝置不會再跳一次。
    // 寫不進去就必須回錯——原本一律回 ok，記號沒蓋上前端也以為蓋上了，
    // 於是下次登入引導又跳出來，而兩端都沒有任何一處說得出為什麼。
    if (body.mode === "set_guide_seen") {
      const r = await markGuideSeen(db, uid);
      if (!r.ok) {
        console.error("set_guide_seen failed", uid, r.msg);
        return Response.json({ kind: "err", msg: "guide_seen_not_saved:" + r.msg }, { status: 500, headers: CORS });
      }
      return Response.json({ kind: "ok", guideSeen: true }, { headers: CORS });
    }

    // 解鎖付費配色（買斷）。價格只在後端定義——前端顯示的數字不可信，
    // 扣款一律以這張表為準。
    if (body.mode === "buy_theme") {
      const key = String(body.theme ?? "");
      const price = THEME_PRICES[key];
      if (!price) return Response.json({ kind: "err", msg: "沒有這個配色" }, { headers: CORS });
      const { data: prof } = await db.from("profiles").select("lingshi, owned_themes").eq("id", uid).maybeSingle();
      const owned = (prof?.owned_themes ?? []) as string[];
      if (owned.includes(key)) return Response.json({ kind: "err", msg: "此配色已解鎖" }, { headers: CORS });
      const bal = prof?.lingshi ?? 0;
      if (bal < price) return Response.json({ kind: "err", msg: `靈石不足（需 ${price}，尚有 ${bal}）` }, { headers: CORS });
      // p_ref 不能帶配色代號：ledger.ref_id 是 uuid，塞 "bamboo" 進去 Postgres 當場拋型別錯，
      // 整支 apply_lingshi 回捲——扣款沒發生，而下一行照樣把配色給了出去（等於免費送）。
      // 錯又被 await 吞掉，餘額查回來沒少，畫面上一切正常。配色沒有 uuid 可指，就不指。
      const { error: buyErr } = await db.rpc("apply_lingshi", { p_user: uid, p_action: "buy_theme", p_amount: -price });
      if (buyErr) return Response.json({ kind: "err", msg: "靈石扣款失敗，配色未解鎖" }, { headers: CORS });
      await db.from("profiles").update({ owned_themes: [...owned, key] }).eq("id", uid);
      const { data: after } = await db.from("profiles").select("lingshi").eq("id", uid).maybeSingle();
      return Response.json({ kind: "ok", theme: key, lingshi: after?.lingshi ?? bal - price,
        ownedThemes: [...owned, key] }, { headers: CORS });
    }

    // 每日簽到（七日循環）＋斷簽補簽（gap>1 且 streak>0 → 問補不補）
    if (body.mode === "signin") {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const { data: prof } = await db.from("profiles").select("last_sign_date, sign_streak, lingshi, signin_total").eq("id", uid).maybeSingle();
      if (prof?.last_sign_date === today) return Response.json({ kind: "already", lingshi: prof.lingshi ?? 0, streak: prof.sign_streak ?? 0 }, { headers: CORS });
      const last = (prof?.last_sign_date as string | null) ?? null;
      const streak = prof?.sign_streak ?? 0;
      const signinTotal = prof?.signin_total ?? 0;
      const bal0 = prof?.lingshi ?? 0;
      const gap = last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : 1;
      const broken = last != null && gap > 1 && streak > 0;

      let newStreak: number, mended = false;
      if (broken) {
        // 尚未決定 → 回報斷簽，前端彈窗問「補簽續連 / 重新開始」（不寫入）
        if (body.mend === undefined)
          return Response.json({ kind: "broken", streak, missed: gap - 1, cost: COST_MEND, lingshi: bal0, canAfford: bal0 >= COST_MEND }, { headers: CORS });
        if (body.mend === true) {
          if (bal0 < COST_MEND) return Response.json({ kind: "broken", streak, missed: gap - 1, cost: COST_MEND, lingshi: bal0, canAfford: false }, { headers: CORS });
          await db.rpc("apply_lingshi", { p_user: uid, p_action: "signin_mend", p_amount: -COST_MEND });
          newStreak = streak + 1; mended = true;     // 補簽 → 續連
        } else {
          newStreak = 1;                             // 不補 → 重新開始
        }
      } else {
        newStreak = (last && gap === 1) ? streak + 1 : 1;
      }

      const [ls, fav] = SIGN_REWARDS[(newStreak - 1) % 7];
      await db.rpc("apply_lingshi", { p_user: uid, p_action: "signin", p_amount: ls });
      if (fav > 0) for (const cid of ["daoshi_m","daoshi_f","lingshou"]) {
        const { data: u } = await db.from("user_character").upsert({ user_id: uid, character_id: cid }, { onConflict: "user_id,character_id", ignoreDuplicates: false }).select("favor").single();
        await db.from("user_character").update({ favor: Math.min(FAVOR_CAP, (u?.favor ?? 0) + fav) }).eq("user_id", uid).eq("character_id", cid);
      }
      const newTotal = signinTotal + 1;
      await db.from("profiles").update({ last_sign_date: today, sign_streak: newStreak, signin_total: newTotal }).eq("id", uid);
      const { data: bal } = await db.from("profiles").select("lingshi").eq("id", uid).maybeSingle();
      const [nls, nfav] = SIGN_REWARDS[newStreak % 7]; // 明日續簽（連續）獎勵
      const ahBefore = ahUnlockedCount(signinTotal), ahAfter = ahUnlockedCount(newTotal);
      const avatarUnlocked = ahAfter > ahBefore;       // 這次剛解鎖新 a~h 頭像
      return Response.json({
        kind: "ok", gained: ls, favor: fav, streak: newStreak, cycleDay: ((newStreak - 1) % 7) + 1,
        lingshi: bal?.lingshi ?? 0, nextLingshi: nls, nextFavor: nfav,
        mended, signinTotal: newTotal, ahUnlocked: ahAfter,
        avatarUnlocked, newAvatar: avatarUnlocked ? AH_KEYS[ahAfter - 1] : null,
      }, { headers: CORS });
    }

    // 每日運勢卦：免費、每人每日一次、不吃每日三卦額度；不給應期、不可追問展開換評
    if (body.mode === "daily_fortune") {
      const charId = ["daoshi_m", "daoshi_f", "lingshou"].includes(String(body.character_id))
        ? String(body.character_id) : "daoshi_m";
      const r = await dailyFortune(db, { userId: uid, characterId: charId, channel: "web" });
      if (r.kind === "already") return Response.json({ kind: "already", msg: "今日的運勢已經看過了，明日再來。" }, { headers: CORS });
      if (r.kind === "capped") return Response.json({ kind: "err", msg: "幾知觀今日推演已達上限，明日請早。" }, { headers: CORS });
      if (r.kind === "rate_limited") return Response.json({ kind: "err", msg: "手速太快了，稍歇片刻。" }, { headers: CORS });
      if (r.kind === "failed") return Response.json({ kind: "err", msg: "今日運勢推演失敗，稍後再試（未計入今日次數）。" }, { headers: CORS });
      return Response.json({
        kind: "ok", castId: r.castId, tier: r.tier, tierLabel: r.tierLabel,
        qian: { n: r.qian.n, gz: r.qian.gz, poem: r.qian.poem, allusion: r.qian.allusion },
        jieqi: r.jieqi, reading: r.reading, chart: r.chart, gua_ben: r.chart.benName,
      }, { headers: CORS });
    }

    // 圖鑑收集 + 上卦行獎勵狀態（unlocked=已領取；claimable=集滿待領）
    // unlocked 不與 eligible 相乘：領過的頭像是玩家的，就算收集度日後有變也不收回。
    if (body.mode === "collection") {
      const { columns, allDone, eligible } = await computeCollection(db, uid, true);
      const claimed = await claimedRewards(db, uid);
      const ownedCount = columns.reduce((s, c) => s + c.count, 0);
      return Response.json({
        kind: "ok", columns, allDone, ownedCount, ...rewardState(eligible, claimed),
      }, { headers: CORS });
    }

    // 領取收集獎勵：集滿不自動解鎖，玩家在卦曆點擊獎勵頭像才領取入袋
    if (body.mode === "claim_reward") {
      const key = String(body.reward ?? "");
      const { eligible } = await computeCollection(db, uid, true);
      if (!eligible.includes(key)) return Response.json({ kind: "err", msg: "卦數未齊，尚不可領" }, { headers: CORS });
      const claimed = await claimedRewards(db, uid);
      if (claimed.includes(key)) return Response.json({ kind: "err", msg: "此獎已領過" }, { headers: CORS });
      await db.from("profiles").update({ claimed_rewards: [...claimed, key] }).eq("id", uid);
      return Response.json({ kind: "ok", reward: key }, { headers: CORS });
    }

    // 設定玩家頭像（a~h 依解鎖數；r07~r10 需已解鎖。御三家 01~06/11~13 不屬玩家池）
    if (body.mode === "set_avatar") {
      const key = String(body.avatar ?? "");
      let ok = false;
      if (/^[a-h]$/.test(key)) {
        const { data: prof } = await db.from("profiles").select("signin_total").eq("id", uid).maybeSingle();
        ok = AH_KEYS.indexOf(key) < ahUnlockedCount(prof?.signin_total ?? 0);
      } else if (PLAYER_REWARDS.includes(key)) {
        ok = (await claimedRewards(db, uid)).includes(key);   // 須已領取（非僅集滿）
      }
      if (!ok) return Response.json({ kind: "err", msg: "頭像未解鎖（集滿後至卦曆領取）" }, { headers: CORS });
      await db.from("profiles").update({ selected_avatar: key }).eq("id", uid);
      return Response.json({ kind: "ok", selected_avatar: key }, { headers: CORS });
    }

    // 設定御三家換裝（每人各自，綁帳號）。avatar 空=還原預設；否則須屬該角色且已解鎖
    if (body.mode === "set_char_avatar") {
      const cid = String(body.character_id ?? "");
      const key = String(body.avatar ?? "");
      if (!CHAR_REWARDS[cid]) return Response.json({ kind: "err", msg: "角色不存在" }, { headers: CORS });
      let val: string | null = null;
      if (key) {
        if (!(key in CHAR_REWARDS[cid])) return Response.json({ kind: "err", msg: "此頭像不屬於該角色" }, { headers: CORS });
        if (!(await claimedRewards(db, uid)).includes(key)) return Response.json({ kind: "err", msg: "此頭像尚未領取（集滿後至卦曆領取）" }, { headers: CORS });
        val = key;
      }
      await db.from("user_character").upsert({ user_id: uid, character_id: cid, avatar: val }, { onConflict: "user_id,character_id" });
      return Response.json({ kind: "ok", character_id: cid, avatar: val }, { headers: CORS });
    }

    /* ═══ 卦案 ═══
       整局由伺服器判定：客戶端只送「我做了什麼」（一個 action），拿回一份重畫用的畫面。
       它不送 state、不送 lines、也拿不到還沒挖出來的線索與 truth——過濾在 case-run.ts。

       這一段刻意不套 rateLimited()：那支是給 AI 請求用的（每分鐘 6 次），
       而卦案零 AI、零 token，一個行動就是一次點擊，套上去等於十秒後就不能玩了。
       這裡的成本是一次 select ＋ 一次 update，該擋的是濫寫不是頻率。 */

    /* ═══ 語音收藏與貼紙的兩個小接頭 ═══ */


    // 心跡每一頁的回應都夾帶那一頁貼了什麼，不必為了貼紙多打一支 API。
    const withStickers = async (r: Awaited<ReturnType<typeof timeline>>, surface: string) =>
      r.ok ? { ...r, payload: { ...r.payload, stickers: await layoutOf(db, uid, surface) } } : r;

    /* ═══ 心跡 ═══
       一件事的一條線。時間軸、溫度線、角色留言、月誌統計全部零 AI——
       整段只有月誌卷首語會呼叫模型，每人每月一次、走 haiku（見 xinji.ts 檔頭的成本紀律）。
       所以這裡跟卦案一樣不套 rateLimited()：那支是給 AI 請求用的，套在每日都會開的頁面上
       只會讓人翻兩下就被擋。 */

    // 時間軸：在記的事、已了結的事、未回覆的角色留言。開頁時順手熬一次留言。
    if (body.mode === "xinji_timeline") {
      return caseResult(await withStickers(await timeline(db, uid, await planOf(db, uid)), "timeline"));
    }

    // 單一心事：歷次卦 ＋ 緣分溫度線
    if (body.mode === "xinji_thread") {
      return caseResult(await withStickers(
        await threadDetail(db, uid, body.thread_id), `thread:${String(body.thread_id ?? "")}`));
    }

    // 記一件新的事（可帶 cast_id 當首卦）。額度滿了回的是人話，不是 quota exceeded。
    if (body.mode === "xinji_open") {
      return caseResult(await openThread(db, uid, await planOf(db, uid), {
        title: body.title, subject: body.subject, category: body.category, castId: body.cast_id,
        // 從閒聊進來的三個：擬好的問句（沒有卦時拿它算 question_norm，否則等他
        // 真的去起卦，一事不二占會把他擋在門外）、一句話總結、誰陪他聊到這裡的。
        question: body.question, note: body.note, characterId: body.character_id,
      }));
    }

    // 把一張散卦歸到既有的線上（從卦曆進來的路徑）
    if (body.mode === "xinji_attach") {
      return caseResult(await attachCast(db, uid, body.cast_id, body.thread_id));
    }

    // 了結／重啟。了結不是刪除：線與卦都還在，只是不再佔在記的額度。
    if (body.mode === "xinji_close") {
      return caseResult(await setThreadStatus(db, uid, await planOf(db, uid), body.thread_id, body.close !== false));
    }

    if (body.mode === "xinji_delete") {
      return caseResult(await deleteThread(db, uid, body.thread_id));
    }

    // 起卦前比對：這句問的是不是已經在記的某件事。
    // 這是「一事不二占從一道牆翻成一條線」的接點——前端拿到 thread 就改問
    // 「這件事我記得，現在到哪了？」而不是「你問過了」。
    if (body.mode === "xinji_suggest") {
      return caseResult(await suggestThread(db, uid, body.question));
    }

    // 「回牠一句」：標記已回，回傳該找誰、開場白帶什麼。
    // 這一支不計費——它只把人送進閒聊，計費由 chat 照既有規則走。
    if (body.mode === "xinji_note_reply") {
      return caseResult(await replyToNote(db, uid, body.note_id));
    }

    if (body.mode === "xinji_note_read") {
      return caseResult(await markNotesRead(db, uid, body.note_ids));
    }

    // 往月目錄（畫「往月　未啟封」那一列）
    if (body.mode === "xinji_month_index") {
      return caseResult(await monthlyIndex(db, uid, await planOf(db, uid)));
    }

    // 月誌。免費：統計照給、卷首語鎖上（locked_reason 是可直接顯示的中文）。
    // 付費：有存的取存的，沒有就生一次再存。生成失敗照給統計——
    // 少一段卷首語是遺憾，整頁打不開是故障。
    if (body.mode === "xinji_month") {
      const plan = await planOf(db, uid);
      const r = await monthlyReview(db, uid, plan, body.ym, async (digest) => {
        // 司籍不是三位角色中的任何一位，所以聲線位置給一句中性的定位，
        // 而不是把大師兄的人設塞進來——那樣寫出來的卷首語會開始叫人「護道人」。
        const ai = await callInterpret("你是幾知觀的司籍，只記錄、不評斷、不安慰。", digest, {
          monthly: { ym: String(body.ym ?? "") },
        });
        await logUsage(db, { userId: uid, mode: ai.mode, model: ai.model, usage: ai.usage, estimated: ai.estimated });
        return { text: ai.reading, model: ai.model, usage: ai.usage, estimated: ai.estimated };
      });
      const ym = /^\d{4}-\d{2}$/.test(String(body.ym ?? "")) ? String(body.ym)
        : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
      return caseResult(await withStickers(r, `month:${ym}`));
    }

    /* ═══ 語音收藏 ═══
       收藏＝記住「哪幾個音檔、照什麼順序播」。音檔在 tts bucket 的共用快取裡，
       本來就永久留著，所以收藏零複製、零上傳，也不另外扣朗讀額度。
       重聽永遠免費——額度用完能聽，玉牒到期也還在（見 voice.ts 檔頭）。 */

    if (body.mode === "voice_list") {
      const plan = await planOf(db, uid);
      // 補逐字稿那條路由這裡注入：voice.ts 不 import tts.ts（見它的檔頭），
      // 而把當初念的字找回來要用到 tts 那邊的切法與快取鍵。
      // 只補得回卦那一邊：閒聊收的那幾則從第一天起就存了逐字稿，沒有舊帳要補。
      const r = await voiceList(db, uid, plan,
        (clip) => clip.cast_id ? castTexts(db, uid, clip.cast_id, clip.text_hash) : Promise.resolve(null));
      // 朗讀額度也在這一頁報出來：本月還能請人念多少，該讓人隨時看得到，
      // 而不是等到用完那一次才第一次知道有這回事。
      if (r.ok) r.payload.tts_quota = await ttsQuota(db, uid, plan);
      return caseResult(r);
    }

    // 收藏走的是與朗讀完全相同的合成路徑：聽過的命中快取不花錢，
    // 沒聽過就按收藏＝合成一次，與按下朗讀同一個價錢。不另立一條規則。
    if (body.mode === "voice_keep") {
      const plan = await planOf(db, uid);
      return caseResult(await voiceKeep(db, uid, plan, (t) =>
        t.kind === "chat"
          ? speakChat(db, uid, plan, t.messageId)
          : speakCast(db, uid, plan, t.castId, t.part), body));
    }

    if (body.mode === "voice_delete") {
      return caseResult(await voiceDelete(db, uid, body.clip_id));
    }

    /* ═══ 貼紙 ═══
       零 AI、純毛利。價錢寫在抽屜裡不另跳商店頁——人是在「想貼」的那一刻掏錢。 */

    if (body.mode === "sticker_shelf") {
      return caseResult(await stickerShelf(db, uid));
    }

    if (body.mode === "sticker_buy") {
      return caseResult(await buyPack(db, uid, body.pack_id, async (price, packId) => {
        const { error } = await db.rpc("apply_lingshi",
          { p_user: uid, p_action: "sticker_pack", p_amount: -price });
        if (error) return false;
        // 收支列表展開時要說得出這筆買到的是哪一包。ledger.ref_id 是 uuid，
        // 而 pack_id 是文字鍵接不上，所以靠 action 區分即可（同 buy_theme 的作法）。
        console.log(`[sticker] ${uid} bought ${packId} for ${price}`);
        return true;
      }));
    }

    if (body.mode === "sticker_place") {
      return caseResult(await placeSticker(db, uid, body));
    }

    if (body.mode === "sticker_move") {
      return caseResult(await moveSticker(db, uid, body));
    }

    if (body.mode === "sticker_remove") {
      return caseResult(await removeSticker(db, uid, body.id));
    }

    // 語音頁那一面（心跡三頁的貼紙夾在各自的回應裡，這支給不走那三支的頁面用）
    if (body.mode === "sticker_layout") {
      return caseResult(await stickerLayout(db, uid, body.surface));
    }

    // 卦案清單、進行中的局、已封存的記憶檔案（含配額）
    if (body.mode === "case_list") {
      return caseResult(await listCases(db, uid, await planOf(db, uid)));
    }

    // 進案：伺服器擲卦並開局。已有進行中的局就把那一局讀回來（resumed:true），不另開一局。
    if (body.mode === "case_start") {
      return caseResult(await startCase(db, uid, body.case_id, body.companion));
    }

    // 讀檔：重建當前畫面（切頁、重開 App、換裝置都走這支）
    if (body.mode === "case_state") {
      return caseResult(await caseStateOf(db, uid, body.run_id));
    }

    // 行動：搜索／查看／攀談／請同行／移動／結案，全由 action.kind 分派
    if (body.mode === "case_action") {
      return caseResult(await actOnCase(db, uid, body.run_id, body.action));
    }

    // 封存／取消封存為記憶檔案（免費 1 格、付費 3 格）
    if (body.mode === "case_keep") {
      return caseResult(await keepRun(db, uid, body.run_id, body.keep !== false, await planOf(db, uid)));
    }

    // 捨棄存檔
    if (body.mode === "case_delete") {
      return caseResult(await deleteRun(db, uid, body.run_id));
    }

    /* ═══ 朗讀解卦 ═══
       客戶端只指名「哪一卦的哪一段」，不送要念的字。
       開放送文字等於把金鑰做成公用 TTS——任何拿得到 JWT 的人都能拿它念小說，
       帳單記在觀主頭上。念什麼由伺服器自己去 casts 撈。

       回的是一串音檔網址而不是一份：長批文切段各自合成，前端照順序播。
       不在伺服器把 mp3 接起來——裸接 frame 只是「多半能播」，
       壞的時候在測試機上未必重現得出來。 */
    if (body.mode === "tts") {
      const plan = await planOf(db, uid);
      // chat_id＝念閒聊裡角色說的那一句。同一支 mode、同一份額度、同一個快取——
      // 另開一支 mode 的話，「命中快取不吃額度」這條就得在兩個地方各守一次。
      const r = body.chat_id != null
        ? await speakChat(db, uid, plan, body.chat_id)
        : await speakCast(db, uid, plan, body.cast_id, body.part ?? "body");
      return r.ok
        ? Response.json({ kind: "ok", ...r.payload }, { headers: CORS })
        : Response.json({ kind: "error", msg: r.msg }, { headers: CORS });
    }

    /* ═══ 道緣事件 ═══
       進度與身分一律由伺服器判定。客戶端只送「我做了什麼」，不送「我因此得到什麼」——
       localStorage 玩家自己改得動，拿它當憑據等於把解鎖權交出去。 */

    // 事件目錄：某角色已發佈的章。只給章名、摘要、幾幕與門檻，不含任何一句台詞——
    // 清單頁一次畫全部的章，把台詞一起送下去等於開啟之前先劇透完。
    if (body.mode === "event_list") {
      return caseResult(await listEvents(db, body.character_id));
    }

    // 開一章：門檻（已發佈／前一章已了結／道緣足夠）在這裡才真正驗，過了才給 scenes。
    // 清單上那句「道緣 300 可啟」是畫給人看的，擋不住直接打 API 的人。
    if (body.mode === "event_open") {
      return caseResult(await openEvent(db, uid, body.event_id));
    }

    // 已完成的事件 id（取代前端暫存的 storyDone）
    if (body.mode === "event_progress") {
      const { data: rows } = await db.from("user_character_events")
        .select("event_id, chosen, completed_at").eq("user_id", uid).not("completed_at", "is", null);
      const done: Record<string, { chosen: string | null; at: string }> = {};
      for (const r of (rows ?? []) as { event_id: string; chosen: string | null; completed_at: string }[])
        done[r.event_id] = { chosen: r.chosen, at: r.completed_at };
      // 順帶回傳已選身分：名片、聊天抬頭、卦例詳情三處都要同步顯示，
      // 分三支 API 去問等於為了一行字打三次網路。
      const { data: ucs } = await db.from("user_character").select("character_id, title_tag").eq("user_id", uid);
      const picked = (ucs ?? []).filter((r: { title_tag: string | null }) => r.title_tag);
      const { data: labels } = picked.length
        ? await db.from("character_titles").select("id, label").in("id", picked.map((r: { title_tag: string }) => r.title_tag))
        : { data: [] };
      const labelOf = new Map((labels ?? []).map((t: { id: string; label: string }) => [t.id, t.label]));
      const titles: Record<string, { id: string; label: string }> = {};
      for (const r of picked as { character_id: string; title_tag: string }[])
        if (labelOf.has(r.title_tag)) titles[r.character_id] = { id: r.title_tag, label: labelOf.get(r.title_tag)! };
      // 目錄一併帶下去（不含任何台詞）：道緣卡片上那顆「事件」鈕要當場決定亮不亮，
      // 為了三顆鈕的狀態再打三次網路太蠢——與 titles 併在這裡是同一個理由。
      const cat = await listEvents(db);
      return Response.json({
        kind: "ok", done, titles,
        catalog: cat.ok ? (cat.payload as { catalog: unknown }).catalog : {},
      }, { headers: CORS });
    }

    // 完成一章。獎勵只在 completed_at 由 null 轉 now() 的那一次發放——
    // 用唯一性約束當併發仲裁者（同 cast_claims 的思路），重放請求拿不到第二份。
    if (body.mode === "event_finish") {
      const evId = String(body.event_id ?? "");
      const chosen = body.chosen == null ? null : String(body.chosen).slice(0, 40);
      const { data: ev } = await db.from("character_events")
        .select("id, character_id, require_favor, require_event, rewards").eq("id", evId).maybeSingle();
      if (!ev) return Response.json({ kind: "err", msg: "查無此事件" }, { headers: CORS });

      // 道緣門檻：現在才驗，因為前端擋得住的東西不等於伺服器可以不擋
      const { data: uc } = await db.from("user_character").select("favor")
        .eq("user_id", uid).eq("character_id", ev.character_id).maybeSingle();
      if ((uc?.favor ?? 0) < (ev.require_favor ?? 0))
        return Response.json({ kind: "err", msg: "道緣未至" }, { headers: CORS });

      // 前置章未完成就不能跳關
      if (ev.require_event) {
        const { data: prev } = await db.from("user_character_events").select("completed_at")
          .eq("user_id", uid).eq("event_id", ev.require_event).maybeSingle();
        if (!prev?.completed_at) return Response.json({ kind: "err", msg: "前一章尚未了結" }, { headers: CORS });
      }

      const { data: cur } = await db.from("user_character_events").select("completed_at")
        .eq("user_id", uid).eq("event_id", evId).maybeSingle();
      const firstTime = !cur?.completed_at;
      await db.from("user_character_events").upsert(
        { user_id: uid, event_id: evId, chosen, completed_at: cur?.completed_at ?? new Date().toISOString() },
        { onConflict: "user_id,event_id" });

      // 重看時只更新選項，不再發一次獎勵
      const rw = (ev.rewards ?? {}) as Record<string, unknown>;
      if (firstTime && typeof rw.memory === "string" && rw.memory.trim())
        await db.from("character_memories")
          .insert({ user_id: uid, character_id: ev.character_id, body: rw.memory, source: "event" });

      return Response.json({ kind: "ok", event_id: evId, chosen, firstTime, rewards: firstTime ? rw : {} }, { headers: CORS });
    }

    // 可選身分清單＋解鎖狀態（解鎖判定在伺服器，前端只負責顯示）
    if (body.mode === "char_titles") {
      const cid = String(body.character_id ?? "");
      const { data: list } = await db.from("character_titles")
        .select("id, label, unlock_event").eq("character_id", cid).order("seq");
      const { data: doneRows } = await db.from("user_character_events")
        .select("event_id").eq("user_id", uid).not("completed_at", "is", null);
      const done = new Set((doneRows ?? []).map((r: { event_id: string }) => r.event_id));
      const { data: uc } = await db.from("user_character").select("title_tag")
        .eq("user_id", uid).eq("character_id", cid).maybeSingle();
      // voice_hint 不下發：那是給模型看的，不是給人看的，外流等於劇透兼被玩家調校
      const items = (list ?? []).map((t: { id: string; label: string; unlock_event: string | null }) =>
        ({ id: t.id, label: t.label, unlock_event: t.unlock_event, unlocked: !t.unlock_event || done.has(t.unlock_event) }));
      return Response.json({ kind: "ok", items, selected: uc?.title_tag ?? null }, { headers: CORS });
    }

    // 換身分。會改變他聊天時的聲口（voice_hint 注進 systemPrompt 的 tail）
    if (body.mode === "set_char_title") {
      const cid = String(body.character_id ?? "");
      const tid = String(body.title_id ?? "");
      if (!tid) {   // 空字串＝回復預設
        await db.from("user_character").upsert({ user_id: uid, character_id: cid, title_tag: null }, { onConflict: "user_id,character_id" });
        return Response.json({ kind: "ok", character_id: cid, title_id: null }, { headers: CORS });
      }
      // 綁 character_id 一起查：別人的身分套不到這個角色身上
      const { data: t } = await db.from("character_titles")
        .select("id, label, unlock_event").eq("id", tid).eq("character_id", cid).maybeSingle();
      if (!t) return Response.json({ kind: "err", msg: "此身分不屬於該角色" }, { headers: CORS });
      if (t.unlock_event) {
        const { data: done } = await db.from("user_character_events").select("completed_at")
          .eq("user_id", uid).eq("event_id", t.unlock_event).maybeSingle();
        if (!done?.completed_at) return Response.json({ kind: "err", msg: "此身分尚未解鎖" }, { headers: CORS });
      }
      await db.from("user_character").upsert({ user_id: uid, character_id: cid, title_tag: tid }, { onConflict: "user_id,character_id" });
      return Response.json({ kind: "ok", character_id: cid, title_id: tid, label: t.label }, { headers: CORS });
    }

    // 載入聊天歷史（前端顯示用；記憶後端本就保存）
    if (body.mode === "chat_history") {
      // 取「最新」40 則（原本 ascending+limit 是取最舊 40）。
      // 依 id 排，不依 created_at：同一問答常常同一個 timestamp，那時就得再補一個
      // role 排序鍵去猜誰先誰後。id 是 bigserial，本來就是寫入順序，一個鍵就夠準。
      // id 一起下發——朗讀與收藏閒聊那一句，客戶端送的就是它。
      const { data: msgs } = await db.from("chat_messages").select("id, role, body")
        .eq("user_id", uid).eq("character_id", body.character_id)
        .order("id", { ascending: false })
        .limit(40);
      return Response.json({ kind: "ok", messages: (msgs ?? []).reverse() }, { headers: CORS });
    }

    // 刪除單卦（連同追問、應期紀錄）
    if (body.mode === "delete_cast") {
      await db.from("followups").delete().eq("cast_id", body.cast_id);
      await db.from("feedback").delete().eq("cast_id", body.cast_id);
      const { error } = await db.from("casts").delete().eq("id", body.cast_id).eq("user_id", uid);
      return Response.json({ kind: error ? "err" : "ok" }, { headers: CORS });
    }

    // 改暱稱
    if (body.mode === "set_nickname") {
      const nick = String(body.nickname ?? "").trim().slice(0, 20);
      if (!nick) return Response.json({ kind: "err", msg: "暱稱不可空白" }, { headers: CORS });
      await db.from("profiles").update({ display_name: nick }).eq("id", uid);
      return Response.json({ kind: "ok", nickname: nick }, { headers: CORS });
    }

    // ── 回憶（共憶）：記憶一則一列，額度依方案。額度不落資料——
    //    取用時 limit N，所以升降方案、刪一則後面遞補全自動成立。
    //    清單一次回全部（含溢出的），前端才畫得出「鎖住的那幾則」。
    if (body.mode === "memory_list") {
      const cid = String(body.character_id ?? "");
      if (!["daoshi_m", "daoshi_f", "lingshou"].includes(cid)) return Response.json({ kind: "err", msg: "角色不存在" }, { headers: CORS });
      const plan = await planOf(db, uid);
      const cap = memoryQuotaOf(plan), pinCap = pinQuotaOf(plan);
      const { data, error } = await db.from("character_memories")
        .select("id, body, source, pinned_at, created_at")
        .eq("user_id", uid).eq("character_id", cid)
        .order("pinned_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) return Response.json({ kind: "err", msg: "回憶暫時讀不到" }, { headers: CORS });
      const rows = data ?? [];
      // 前 cap 則＝角色現在記得的；其後＝溢出被鎖（資料還在，補訂閱即回）
      const items = rows.map((m, i) => ({ ...m, locked: i >= cap }));
      const pinned = rows.filter((m) => m.pinned_at).length;
      return Response.json({ kind: "ok", items, cap, pinCap, pinned, plan }, { headers: CORS });
    }

    // 刪一則回憶：刪掉之後被鎖的下一則自動遞補進額度內（不需任何同步）
    if (body.mode === "memory_delete") {
      const { error } = await db.from("character_memories")
        .delete().eq("id", String(body.memory_id ?? "")).eq("user_id", uid);
      return Response.json({ kind: error ? "err" : "ok" }, { headers: CORS });
    }

    // 釘選／取消釘選：釘住的永不因額度縮減而溢出。釘選數依方案上限。
    if (body.mode === "memory_pin") {
      const id = String(body.memory_id ?? "");
      const want = !!body.pin;
      const plan = await planOf(db, uid);
      const pinCap = pinQuotaOf(plan);
      if (want) {
        if (pinCap <= 0) return Response.json({ kind: "err", msg: "此方案尚不能釘選回憶" }, { headers: CORS });
        const { count } = await db.from("character_memories")
          .select("id", { count: "exact", head: true })
          .eq("user_id", uid).not("pinned_at", "is", null);
        if ((count ?? 0) >= pinCap) {
          return Response.json({ kind: "err", msg: `釘選已滿（${pinCap} 則，三位角色共用），先取消一則再釘` }, { headers: CORS });
        }
      }
      const { error } = await db.from("character_memories")
        .update({ pinned_at: want ? new Date().toISOString() : null })
        .eq("id", id).eq("user_id", uid);
      return Response.json({ kind: error ? "err" : "ok", pinned: want }, { headers: CORS });
    }

    // 自訂提醒：列表
    if (body.mode === "reminder_list") {
      const { data: rows } = await db.from("reminders")
        .select("id, date, time, title, character_id, lead_days")
        .eq("user_id", uid).order("date", { ascending: true });
      return Response.json({ kind: "ok", reminders: rows ?? [] }, { headers: CORS });
    }

    // 自訂提醒：新增
    if (body.mode === "reminder_set") {
      const title = String(body.title ?? "").trim().slice(0, 60);
      const date = String(body.date ?? "");
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return Response.json({ kind: "err", msg: "提醒需有項目與日期" }, { headers: CORS });
      const { data: row, error } = await db.from("reminders").insert({
        user_id: uid, date, title,
        time: body.time || null,
        character_id: body.character_id || null,
        lead_days: Number(body.lead_days) || 0,
      }).select("id, date, time, title, character_id, lead_days").single();
      if (error) return Response.json({ kind: "err", msg: "寫入失敗" }, { headers: CORS });
      return Response.json({ kind: "ok", reminder: row }, { headers: CORS });
    }

    // 自訂提醒：刪除
    if (body.mode === "reminder_del") {
      await db.from("reminders").delete().eq("id", body.id).eq("user_id", uid);
      return Response.json({ kind: "ok" }, { headers: CORS });
    }

    // 靈石收支紀錄（近 30 天，新→舊；ledger 為終身流水，僅查詢時取窗）
    //
    // 回兩份：days 是「當天 × 項目」的分組（閒聊一晚十七句收成一列「閒聊 −17」，
    // 展開才看得到每一筆的時間與問句），logs 是原本的逐筆流水。logs 留著是因為
    // 前端還在讀它——等畫面換成 days，這一欄才拿得掉。
    //
    // 上限拉到 LEDGER_WINDOW：分組之後一列可能代表幾十筆，原本的 100 筆連一週都撐不完。
    // 撈滿代表最舊那天可能只有一半，那一天整天不出（見 ledger.ts 開頭）。
    if (body.mode === "lingshi_log") {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { data: raw } = await db.from("ledger").select("id, action, amount, created_at, ref_id")
        .eq("user_id", uid).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(LEDGER_WINDOW);
      const rows = (raw ?? []) as LedgerRow[];
      const details = await ledgerDetails(db, rows);
      const days = groupLedger(rows, details);
      const truncated = rows.length >= LEDGER_WINDOW;
      if (truncated) days.pop();   // 最舊那天可能被切一半，合計會是錯的——寧可不給
      return Response.json({
        kind: "ok", days, truncated, since,
        logs: rows.map((r) => ({ action: r.action, amount: r.amount, created_at: r.created_at })),
      }, { headers: CORS });
    }

    // 卦曆列表
    if (body.mode === "history") {
      const { data: casts } = await db.from("casts")
        .select("id, question, gua_ben, gua_bian, created_at, due_date, character_id, yong_qin, yong_via_shi, feedback(verdict, note)")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(60);
      return Response.json({ kind: "ok", casts: casts ?? [] }, { headers: CORS });
    }

    // 重溫單卦（含追問串）
    if (body.mode === "cast_detail") {
      const { data: c } = await db.from("casts")
        .select("id, question, chart, reading, deep_reading, gua_ben, gua_bian, created_at, due_date, character_id, yong_qin, yong_via_shi, feedback(verdict, note)")
        .eq("id", body.cast_id).eq("user_id", uid).maybeSingle();
      if (!c) return Response.json({ kind: "not_found" }, { headers: CORS });
      const { data: fus } = await db.from("followups").select("question, answer, created_at")
        .eq("cast_id", body.cast_id).order("created_at", { ascending: true });
      return Response.json({ kind: "ok", cast: c, followups: fus ?? [] }, { headers: CORS });
    }

    // 應期回評：1準 2部分 3不準（回評後修為+50，紅點消）＋選填評語（可匿名公開到觀前石牆）
    if (body.mode === "review") {
      const v = Number(body.verdict);
      if (![1, 2, 3].includes(v)) return Response.json({ kind: "err" }, { headers: CORS });
      const { data: c } = await db.from("casts").select("character_id").eq("id", body.cast_id).eq("user_id", uid).maybeSingle();
      if (!c) return Response.json({ kind: "not_found" }, { headers: CORS });
      const note = String(body.note ?? "").trim().slice(0, 120);
      const isPublic = body.is_public === true && note.length > 0;
      // 只有「首次回評」才發修為與靈石（防重複送出刷獎）；後續仍可改寫評語但不再發獎
      const { data: prevFb } = await db.from("feedback").select("verdict").eq("cast_id", body.cast_id).maybeSingle();
      const firstTime = !(prevFb && prevFb.verdict && prevFb.verdict > 0);
      await db.from("feedback").upsert({ cast_id: body.cast_id, user_id: uid, verdict: v, note: note || null, is_public: isPublic, answered_at: new Date().toISOString() }, { onConflict: "cast_id" });
      let lingshi = 0;
      if (firstTime) {
        const { data: uc } = await db.from("user_character").select("cultivation").eq("user_id", uid).eq("character_id", c.character_id).maybeSingle();
        await db.from("user_character").upsert({ user_id: uid, character_id: c.character_id, cultivation: (uc?.cultivation ?? 0) + 50 }, { onConflict: "user_id,character_id" });
        lingshi = note.length > 0 ? 2 : 1;   // 有留印證評語 +2；只點準不準 +1
        await db.rpc("apply_lingshi", { p_user: uid, p_action: "feedback", p_amount: lingshi, p_ref: body.cast_id });
      }
      return Response.json({ kind: "ok", lingshi }, { headers: CORS });
    }

    // 閒聊（複用 chat()：Haiku→NVIDIA→罐頭、扣好感、scrubBilling、記憶滾動）
    if (body.mode === "chat") {
      const r = await chat(db, { userId: uid, characterId: body.character_id, message: String(body.message ?? ""), plan: await planOf(db, uid) });
      return Response.json({
        kind: "ok", reply: r.reply, tier: r.tier, favorLeft: r.favorLeft, cost: r.cost,
        freeLeft: r.freeLeft, lingshiLeft: r.lingshiLeft, wantCast: r.wantCast,
        probe: r.probe,                                    // 探詢輪：前端不出起卦鈕
        draft: r.draft, draftYong: r.draftYong,            // 擬題：前端出確認卡，用神可直通
        // 擬題那一刻，這件事在心跡那邊的狀況：已經在記的哪一條、還是替他預備了一條。
        // 確認卡上多一行「先記下這件事」，按了就是 xinji_open，再帶著 thread_id 去起卦。
        xinji: r.xinji,
        msg_id: r.msgId,   // 這一則要朗讀或收藏時指名用（tts / voice_keep 的 chat_id）
      }, { headers: CORS });
    }

    // 問句預檢（問事頁送出前）：只提議、不攔阻；任何失敗都回 ok:true 靜默放行
    if (body.mode === "refine") {
      const r = await refineQuestion(db, { userId: uid, question: String(body.question ?? "") });
      return Response.json({ kind: "ok", ...r }, { headers: CORS });
    }

    // 觀前廣場：發文（自由心得 thread/chat_story 直存；分享卦 cast 讀快照驗本人）
    if (body.mode === "post_create") {
      const type = String(body.type ?? "");
      if (!["cast", "thread", "chat_story"].includes(type))
        return Response.json({ kind: "err", msg: "型別不明" }, { headers: CORS });
      const title = String(body.title ?? "").trim().slice(0, 60);
      const bodyText = String(body.body ?? "").trim().slice(0, 1000);
      if (!title) return Response.json({ kind: "err", msg: "標題不可空白" }, { headers: CORS });
      if (!bodyText) return Response.json({ kind: "err", msg: "內容不可空白" }, { headers: CORS });
      // 每日發文上限（沿用 free_quota，台北日界）
      const pday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const pkey = `postfree:${uid}:${pday}`;
      const { data: pq } = await db.from("free_quota").select("used_today, last_reset").eq("key", pkey).maybeSingle();
      const pused = (pq && pq.last_reset === pday) ? pq.used_today : 0;
      if (pused >= POST_DAILY_LIMIT)
        return Response.json({ kind: "err", msg: `今日發文已達上限（${POST_DAILY_LIMIT} 篇）` }, { headers: CORS });

      let snapshot: Record<string, unknown> | null = null;
      let chatSnapshot: Record<string, unknown> | null = null;
      let charId: string | null = body.character_id ? String(body.character_id) : null;
      if (type === "cast") {
        // 分享卦：後端讀 casts 快照，驗 cast.user_id 是本人；複製 reading/卦名/角色進 posts，不 live join
        const { data: c } = await db.from("casts")
          .select("user_id, question, gua_ben, gua_bian, reading, character_id, chart, yong_qin, yong_via_shi")
          .eq("id", body.cast_id).maybeSingle();
        if (!c || c.user_id !== uid) return Response.json({ kind: "err", msg: "只能分享自己的卦" }, { headers: CORS });
        snapshot = { question: c.question, gua_ben: c.gua_ben, gua_bian: c.gua_bian, reading: stripReadingGuide(c.reading) };
        // 勾了「附上盤面」才帶 chart（含用神，內頁重繪盤面用）
        if (body.with_chart === true && c.chart) {
          snapshot.chart = c.chart;
          snapshot.yong_qin = c.yong_qin ?? null;
          snapshot.yong_via_shi = c.yong_via_shi ?? null;
        }
        charId = c.character_id;
      }
      if (type === "chat_story" && Array.isArray(body.chat_excerpt)) {
        // 閒聊節錄：前端連續勾選的對話框。逐則驗證，總字數硬上限（前端同值先擋，這裡防繞過）
        const msgs = body.chat_excerpt.slice(0, CHAT_EXCERPT_MSGS)
          .map((m: { me?: unknown; text?: unknown }) => ({ me: m?.me === true, text: String(m?.text ?? "").trim().slice(0, CHAT_EXCERPT_MAX) }))
          .filter((m: { text: string }) => m.text);
        const total = msgs.reduce((n: number, m: { text: string }) => n + m.text.length, 0);
        if (!msgs.length) return Response.json({ kind: "err", msg: "節錄內容是空的" }, { headers: CORS });
        if (total > CHAT_EXCERPT_MAX)
          return Response.json({ kind: "err", msg: `節錄超過可分享字數（${CHAT_EXCERPT_MAX} 字）` }, { headers: CORS });
        chatSnapshot = { character_id: charId, messages: msgs };
      }
      const { data: row, error } = await db.from("posts").insert({
        user_id: uid, type, title, body: bodyText, cast_snapshot: snapshot, chat_snapshot: chatSnapshot, character_id: charId,
      }).select("id").single();
      if (error) {
        console.error("post_create insert failed", error);
        return Response.json({ kind: "err", msg: "發文失敗" }, { headers: CORS });
      }
      await db.from("free_quota").upsert({ key: pkey, used_today: pused + 1, last_reset: pday });
      return Response.json({ kind: "ok", id: row!.id, postsLeft: POST_DAILY_LIMIT - pused - 1 }, { headers: CORS });
    }

    // 觀前廣場：按讚（不能讚自己；複合 PK 防重；達門檻一次性發獎）
    if (body.mode === "post_like") {
      const { data: p } = await db.from("posts").select("user_id").eq("id", body.post_id).maybeSingle();
      if (!p) return Response.json({ kind: "err", msg: "貼文不存在" }, { headers: CORS });
      if (p.user_id === uid) return Response.json({ kind: "err", msg: "不能讚自己的貼文" }, { headers: CORS });
      // 靠複合 PK 防重複；已讚過（conflict）→ 不加數、不重複發獎
      const { error: likeErr } = await db.from("post_likes").insert({ post_id: body.post_id, user_id: uid });
      if (likeErr) return Response.json({ kind: "liked", msg: "已印過此帖" }, { headers: CORS });
      // like_count + 1（用 RPC 原子自增，避免併發讀後寫丟數），回傳新讚數
      const { data: newCount } = await db.rpc("bump_post_like", { p_post: body.post_id });
      const likeCount = (newCount as number | null) ?? 0;
      // 達門檻且未發過 → 原子搶 rewarded_at，搶到才發獎（一次性、防併發重複）
      let rewarded = false;
      if (likeCount >= POST_HOT_THRESHOLD) {
        const { data: won } = await db.from("posts")
          .update({ rewarded_at: new Date().toISOString() })
          .eq("id", body.post_id).gte("like_count", POST_HOT_THRESHOLD).is("rewarded_at", null)
          .select("id");
        if (won && won.length > 0) {
          await db.rpc("apply_lingshi", { p_user: p.user_id, p_action: "post_hot", p_amount: POST_HOT_REWARD, p_ref: body.post_id });
          rewarded = true;
        }
      }
      return Response.json({ kind: "ok", likeCount, rewarded }, { headers: CORS });
    }

    // 觀前廣場：刪文（本人；或觀主可刪任意）。post_likes/post_comments 靠 cascade 一併刪除
    if (body.mode === "post_del") {
      const isAdmin = ADMIN_USER_ID && uid === ADMIN_USER_ID;
      let del = db.from("posts").delete().eq("id", body.post_id);
      if (!isAdmin) del = del.eq("user_id", uid); // 非管理員只能刪自己的
      const { error } = await del;
      return Response.json({ kind: error ? "err" : "ok" }, { headers: CORS });
    }

    // 觀前廣場：置頂／取消置頂（僅管理員）。pinned_at 記時點，列表置頂優先
    if (body.mode === "post_pin") {
      const isAdmin = ADMIN_USER_ID && uid === ADMIN_USER_ID;
      if (!isAdmin) return Response.json({ kind: "err", msg: "無置頂權限" }, { headers: CORS });
      const pinned_at = body.pin === false ? null : new Date().toISOString();
      const { error } = await db.from("posts").update({ pinned_at }).eq("id", body.post_id);
      if (error) return Response.json({ kind: "err" }, { headers: CORS });
      return Response.json({ kind: "ok", pinned: pinned_at !== null }, { headers: CORS });
    }

    // 觀前廣場：回文（登入即可，含回自己的文；每日上限防灌水）
    if (body.mode === "post_comment") {
      const cBody = String(body.body ?? "").trim().slice(0, COMMENT_MAX);
      if (!cBody) return Response.json({ kind: "err", msg: "回文不可空白" }, { headers: CORS });
      const { data: p } = await db.from("posts").select("id").eq("id", body.post_id).maybeSingle();
      if (!p) return Response.json({ kind: "err", msg: "貼文不存在" }, { headers: CORS });
      const cday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const ckey = `commentfree:${uid}:${cday}`;
      const { data: cq } = await db.from("free_quota").select("used_today, last_reset").eq("key", ckey).maybeSingle();
      const cused = (cq && cq.last_reset === cday) ? cq.used_today : 0;
      if (cused >= COMMENT_DAILY_LIMIT)
        return Response.json({ kind: "err", msg: "今日回文已達上限" }, { headers: CORS });
      // 指定回覆：reply_to 指向被回覆的回文。存起來備查，並替被回覆者累加未讀（不通知自己）
      const replyTo = body.reply_to ? String(body.reply_to) : null;
      const { data: row, error } = await db.from("post_comments")
        .insert({ post_id: body.post_id, user_id: uid, body: cBody, reply_to: replyTo }).select("id, created_at").single();
      if (error) {
        console.error("post_comment insert failed", error);
        return Response.json({ kind: "err", msg: "回文失敗" }, { headers: CORS });
      }
      await db.from("free_quota").upsert({ key: ckey, used_today: cused + 1, last_reset: cday });
      const { data: newCount } = await db.rpc("bump_post_comment", { p_post: body.post_id, p_delta: 1 });
      if (replyTo) {
        const { data: tgt } = await db.from("post_comments").select("user_id").eq("id", replyTo).maybeSingle();
        if (tgt && tgt.user_id && tgt.user_id !== uid) {
          // 逐則記錄「哪一篇的哪一則」，而非只累加一個總數——否則使用者只知道有人回他，
          // 卻不知道是哪一篇，紅點形同虛設
          await db.from("plaza_notices").insert({ user_id: tgt.user_id, post_id: body.post_id, comment_id: row!.id });
        }
      }
      return Response.json({ kind: "ok", id: row!.id, created_at: row!.created_at, commentCount: (newCount as number | null) ?? 0 }, { headers: CORS });
    }

    // 觀前廣場：刪回文（本人；或觀主）。先查 post_id 供回文數遞減
    if (body.mode === "post_comment_del") {
      const isAdmin = ADMIN_USER_ID && uid === ADMIN_USER_ID;
      const { data: c } = await db.from("post_comments").select("post_id, user_id").eq("id", body.comment_id).maybeSingle();
      if (!c) return Response.json({ kind: "err", msg: "回文不存在" }, { headers: CORS });
      if (!isAdmin && c.user_id !== uid) return Response.json({ kind: "err", msg: "只能刪自己的回文" }, { headers: CORS });
      const { error } = await db.from("post_comments").delete().eq("id", body.comment_id);
      if (error) return Response.json({ kind: "err" }, { headers: CORS });
      await db.rpc("bump_post_comment", { p_post: c.post_id, p_delta: -1 });
      return Response.json({ kind: "ok" }, { headers: CORS });
    }

    // 觀前廣場：編輯回文（僅本人）。改內容並記 edited_at，前端顯示「編輯於」
    if (body.mode === "post_comment_edit") {
      const cBody = String(body.body ?? "").trim().slice(0, COMMENT_MAX);
      if (!cBody) return Response.json({ kind: "err", msg: "回文不可空白" }, { headers: CORS });
      const { data: c } = await db.from("post_comments").select("user_id").eq("id", body.comment_id).maybeSingle();
      if (!c) return Response.json({ kind: "err", msg: "回文不存在" }, { headers: CORS });
      if (c.user_id !== uid) return Response.json({ kind: "err", msg: "只能編輯自己的回文" }, { headers: CORS });
      const edited_at = new Date().toISOString();
      const { error } = await db.from("post_comments").update({ body: cBody, edited_at }).eq("id", body.comment_id);
      if (error) return Response.json({ kind: "err", msg: "編輯失敗" }, { headers: CORS });
      return Response.json({ kind: "ok", body: cBody, edited_at }, { headers: CORS });
    }

    // 觀前廣場：回文按讚（不能讚自己；複合 PK 防重；達門檻一次性發獎，設計同貼文讚）
    if (body.mode === "comment_like") {
      const { data: c } = await db.from("post_comments").select("user_id").eq("id", body.comment_id).maybeSingle();
      if (!c) return Response.json({ kind: "err", msg: "回文不存在" }, { headers: CORS });
      if (c.user_id === uid) return Response.json({ kind: "err", msg: "不能讚自己的回文" }, { headers: CORS });
      const { error: likeErr } = await db.from("post_comment_likes").insert({ comment_id: body.comment_id, user_id: uid });
      if (likeErr) return Response.json({ kind: "liked", msg: "已印過此回文" }, { headers: CORS });
      const { data: newCount } = await db.rpc("bump_comment_like", { p_comment: body.comment_id });
      const likeCount = (newCount as number | null) ?? 0;
      let rewarded = false;
      if (likeCount >= COMMENT_HOT_THRESHOLD) {
        // 原子搶 rewarded_at，搶到才發獎（一次性、防併發重複）
        const { data: won } = await db.from("post_comments")
          .update({ rewarded_at: new Date().toISOString() })
          .eq("id", body.comment_id).gte("like_count", COMMENT_HOT_THRESHOLD).is("rewarded_at", null)
          .select("id");
        if (won && won.length > 0) {
          await db.rpc("apply_lingshi", { p_user: c.user_id, p_action: "comment_hot", p_amount: COMMENT_HOT_REWARD, p_ref: body.comment_id });
          rewarded = true;
        }
      }
      return Response.json({ kind: "ok", likeCount, rewarded }, { headers: CORS });
    }

    // 會員頁「廣場」頁籤：我參與的貼文（我發的＋我回過文的），同列表形狀
    if (body.mode === "my_plaza") {
      // 刻意不在這裡清未讀：一進列表就清零，人就永遠看不到「是哪一篇」。
      // 改為開啟該篇時才清（見 plaza_seen）。
      const { data: mine } = await db.from("posts").select("id").eq("user_id", uid)
        .order("created_at", { ascending: false }).limit(30);
      const { data: cmts } = await db.from("post_comments").select("post_id").eq("user_id", uid)
        .order("created_at", { ascending: false }).limit(200);
      const ids = [...new Set([...(mine ?? []).map((x: { id: string }) => x.id), ...(cmts ?? []).map((x: { post_id: string }) => x.post_id)])].slice(0, 60);
      if (!ids.length) return Response.json({ kind: "ok", posts: [] }, { headers: CORS });
      const { data: posts, error } = await db.from("posts").select(POST_LIST_COLS)
        .in("id", ids).order("created_at", { ascending: false });
      if (error) return Response.json({ kind: "err", msg: "載入失敗" }, { headers: CORS });
      const entries = await postEntries((posts ?? []) as PostRow[]);
      // 各篇未讀數：紅點要標在標題後面，指得出是哪一篇
      const { data: nts } = await db.from("plaza_notices").select("post_id").eq("user_id", uid);
      const unread = new Map<string, number>();
      for (const n of (nts ?? []) as { post_id: string }[]) unread.set(n.post_id, (unread.get(n.post_id) ?? 0) + 1);
      return Response.json({
        kind: "ok",
        posts: entries.map((p: { id: string }) => ({ ...p, unread: unread.get(p.id) ?? 0 })),
      }, { headers: CORS });
    }

    // 讀過某篇：清掉該篇的未讀（前端開啟貼文內頁時呼叫）
    if (body.mode === "plaza_seen") {
      if (!body.post_id) return Response.json({ kind: "err", msg: "post_id required" }, { headers: CORS });
      await db.from("plaza_notices").delete().eq("user_id", uid).eq("post_id", body.post_id);
      const { count } = await db.from("plaza_notices").select("comment_id", { count: "exact", head: true }).eq("user_id", uid);
      return Response.json({ kind: "ok", plazaUnread: count ?? 0 }, { headers: CORS });
    }

    // 三個月鎖：超過 90 天的卦不能再追問/換評（內容仍可回顧）
    if (body.mode === "followup" || body.mode === "comment") {
      const { data: c } = await db.from("casts").select("created_at").eq("id", body.cast_id).eq("user_id", uid).maybeSingle();
      if (c && Date.now() - new Date(c.created_at).getTime() > 90 * 86400 * 1000) {
        return Response.json({ kind: "locked" }, { headers: CORS });
      }
    }

    // 守門：不認得的 mode 一律 400，禁止 fall-through 進起卦（空卦事故根因）
    if (body.mode && !["followup", "comment", "deepen"].includes(body.mode))
      return Response.json({ kind: "err", msg: "unknown_mode:" + body.mode }, { status: 400, headers: CORS });
    // 守門：起卦必有問事（無事不占）；網頁(JWT)路徑必帶已起好的六爻
    if (!body.mode) {
      if (!String(body.question ?? "").trim())
        return Response.json({ kind: "err", msg: "question_required" }, { status: 400, headers: CORS });
      if (jwtUserId && !(Array.isArray(body.lines) && body.lines.length === 6))
        return Response.json({ kind: "err", msg: "lines_required" }, { status: 400, headers: CORS });
    }

    const result = body.mode === "followup"
      ? await followupInterpret(db, { userId: uid, castId: body.cast_id, question: body.question })
      : body.mode === "comment"
      ? await commentCast(db, { userId: uid, castId: body.cast_id, newCharacterId: body.character_id })
      : body.mode === "deepen"
      ? await deepenCast(db, { userId: uid, castId: body.cast_id })
      : await castAndInterpret(db, {
          // 額度鍵與 user_id 同一條鐵則：登入者一律以 JWT 解出的帳號記帳。
          // 之前是 body.quota_key ?? uid，等於把「這次算誰的額度」交給前端說了算——
          // 每次換一個 quota_key 送上來，每一卦都會是當日第一卦，免費額度形同不存在。
          // body.quota_key 只留給內部金鑰路徑（TG 用 tg:<id> 記在對話上）。
          userId: uid, quotaKey: jwtUserId ? uid : (body.quota_key ?? uid),
          characterId: body.character_id ?? "daoshi_m",
          question: body.question, channel: body.channel ?? "web",
          numbers: body.numbers, lines: body.lines, // ← 網頁傳已起好的卦
          yongQin: body.yong_qin, yongViaShi: body.yong_via_shi,
          castDate: parseCastDate(body.cast_date), // 手動排盤自填占時（無/不合法則後端用當下台北時）
          questionRaw: body.question_raw, questionSource: body.question_source,
      clientToken: typeof body.client_token === "string" ? body.client_token : undefined,
      // 心跡：「就這件事再問一卦」帶著線的 id 進來。帶了就不吃一事不二占的攔截
      // （理由見 pipeline.ts 第 1 步），卦也直接掛到那條線上。
      threadId: typeof body.thread_id === "string" ? body.thread_id : undefined,
    });
    // 日運卦不可追問／展開／換評（今日氣象非問事卦，續談會與正式卦互相打臉）
    if ((result as { kind: string }).kind === "no_followup")
      return Response.json({ kind: "err", msg: "今日運勢只論當日氣象，不另作推演。要細問，另起一卦。" }, { headers: CORS });
    return Response.json(result, { headers: CORS });
  } catch (e) {
    console.error(e);
    return new Response("internal error", { status: 500, headers: CORS });
  }
});
