// interpret/index.ts — HTTP 端點
//  · 網頁公開層：Authorization: Bearer <Supabase Auth JWT>（瀏覽器用，安全）
//  · TG/Mini App 後端內部呼叫：x-internal-key（沿用，向後相容）
import { createClient } from "npm:@supabase/supabase-js@2";
import { castAndInterpret, followupInterpret, deepenCast, commentCast } from "../_shared/pipeline.ts";
import { chat, COST_CHAT, FREE_CHAT_PER_DAY, FAVOR_CAP } from "../_shared/chat.ts";
import { GUA_BY_UPPER } from "../_shared/core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRANT_REGISTER = 50;
const COST_MEND = 10;                       // 斷簽補簽費用（靈石），可調
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? ""; // 觀主內部 user_id：可刪任意廣場貼文
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
const SIGN_REWARDS: [number, number][] = [[10,0],[10,0],[15,5],[15,0],[20,0],[20,0],[50,10]];
const AH_KEYS = ["a","b","c","d","e","f","g","h"];
// 玩家 a~h 頭像解鎖數：註冊解 5，之後每滿 7 次簽到 +1，上限 8
const ahUnlockedCount = (signinTotal: number) => 5 + Math.min(3, Math.floor(signinTotal / 7));
// 上卦行 → 獎勵頭像 key（集滿該行解鎖）；全 64 另給 r11/r12/r13
const UP_ORDER = ["乾","兌","離","震","巽","坎","艮","坤"];
const REWARD_BY_UPPER: Record<string, string[]> = {
  乾:["r01"], 兌:["r02"], 離:["r03"], 震:["r04"], 巽:["r05"], 坎:["r06"], 艮:["r07","r08"], 坤:["r09","r10"],
};
// 御三家換裝：角色 → {獎勵key: 上卦行 或 "ALL"}（解鎖=集滿該行/全64）
const CHAR_REWARDS: Record<string, Record<string, string>> = {
  daoshi_m: { r01:"乾", r04:"震", r11:"ALL" },
  daoshi_f: { r02:"兌", r05:"巽", r12:"ALL" },
  lingshou: { r03:"離", r06:"坎", r13:"ALL" },
};
const PLAYER_REWARDS = ["r07","r08","r09","r10"]; // 玩家池獎勵（其餘 01~06/11~13 屬御三家換裝）

// 收集狀態：distinct gua_ben(＋gua_bian) → 各上卦行進度、已「達成」獎勵
// 注意：unlocked 是「集滿達成」（eligible），非「已領取」。集滿後須玩家至卦曆點擊領取
// （claim_reward）寫入 profiles.claimed_rewards 才算真正解鎖可用。
async function computeCollection(uid: string) {
  const { data: rows } = await db.from("casts").select("gua_ben, gua_bian").eq("user_id", uid);
  const owned = new Set<string>();
  for (const r of (rows ?? []) as { gua_ben: string | null; gua_bian: string | null }[]) {
    if (r.gua_ben) owned.add(r.gua_ben);
    if (r.gua_bian) owned.add(r.gua_bian);
  }
  const columns = UP_ORDER.map((up) => {
    const names = GUA_BY_UPPER[up] ?? [];
    const got = names.filter((n) => owned.has(n));
    const done = names.length > 0 && got.length === names.length;
    return { up, names, owned: got, count: got.length, total: names.length, done, rewards: REWARD_BY_UPPER[up] ?? [] };
  });
  const allDone = columns.every((c) => c.done);
  const unlocked: string[] = [];
  for (const c of columns) if (c.done) unlocked.push(...c.rewards);
  if (allDone) unlocked.push("r11", "r12", "r13");
  return { owned, columns, allDone, unlocked };
}

// 已領取的獎勵頭像 key（真正解鎖可用的集合）
async function getClaimedRewards(uid: string): Promise<string[]> {
  const { data } = await db.from("profiles").select("claimed_rewards").eq("id", uid).maybeSingle();
  return (data?.claimed_rewards ?? []) as string[];
}

// CORS：瀏覽器跨網域呼叫必需。上線時把 * 改成你的網域。
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

// 觀前石牆：公開回評牆＋整體準驗統計（免認證唯讀；只出評語/卦名/暱稱，不含問事原文）
let wallCache: { t: number; payload: unknown } | null = null;
async function wallResponse(): Promise<Response> {
  if (wallCache && Date.now() - wallCache.t < 300_000) return Response.json(wallCache.payload, { headers: CORS });
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
  return Response.json(payload, { headers: CORS });
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
    ? await db.from("profiles").select("id, display_name, selected_avatar").in("id", userIds) : { data: [] };
  const profs = new Map((ps ?? []).map((p: { id: string; display_name: string | null; selected_avatar: string | null }) => [p.id, p]));
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
  const { data: ps } = await db.from("profiles").select("id, display_name, selected_avatar").in("id", userIds);
  const profs = new Map((ps ?? []).map((x: { id: string; display_name: string | null; selected_avatar: string | null }) => [x.id, x]));
  const who = (uid: string) => ({ name: profs.get(uid)?.display_name || "護道人", avatar: profs.get(uid)?.selected_avatar ?? null });
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
      const { data: prof } = await db.from("profiles").select("lingshi, display_name, last_sign_date, selected_avatar, signin_total, claimed_rewards, plaza_unread").eq("id", uid).maybeSingle();
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
      // 今日聊天免費剩餘
      const cday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const { data: cq } = await db.from("free_quota").select("used_today, last_reset").eq("key", `chatfree:${uid}:${cday}`).maybeSingle();
      const cused = (cq && cq.last_reset === cday) ? cq.used_today : 0;
      const chatFreeLeft = Math.max(0, FREE_CHAT_PER_DAY - cused);
      const signedToday = prof?.last_sign_date === cday;
      // 收集獎勵待領數（卦曆鈕紅點用）：集滿達成但尚未領取
      const { unlocked: eligible } = await computeCollection(uid);
      const claimedArr = (prof?.claimed_rewards ?? []) as string[];
      const claimableRewards = eligible.filter((k) => !claimedArr.includes(k)).length;
      return Response.json({ kind: "ok", uid, isAdmin: !!ADMIN_USER_ID && uid === ADMIN_USER_ID, lingshi: prof?.lingshi ?? 0, display_name: prof?.display_name ?? null, favors, realms, cults, charAvatars, dueUnreviewed, chatFreeLeft, chatCost: COST_CHAT, signedToday, selected_avatar: prof?.selected_avatar ?? null, ahUnlocked: ahUnlockedCount(prof?.signin_total ?? 0), claimableRewards, plazaUnread: prof?.plaza_unread ?? 0 }, { headers: CORS });
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

    // 圖鑑收集 + 上卦行獎勵狀態（unlocked=已領取；claimable=集滿待領）
    if (body.mode === "collection") {
      const { columns, allDone, unlocked: eligible } = await computeCollection(uid);
      const claimed = new Set(await getClaimedRewards(uid));
      const ownedCount = columns.reduce((s, c) => s + c.count, 0);
      return Response.json({
        kind: "ok", columns, allDone, ownedCount,
        unlocked: eligible.filter((k) => claimed.has(k)),
        claimable: eligible.filter((k) => !claimed.has(k)),
      }, { headers: CORS });
    }

    // 領取收集獎勵：集滿不自動解鎖，玩家在卦曆點擊獎勵頭像才領取入袋
    if (body.mode === "claim_reward") {
      const key = String(body.reward ?? "");
      const { unlocked: eligible } = await computeCollection(uid);
      if (!eligible.includes(key)) return Response.json({ kind: "err", msg: "卦數未齊，尚不可領" }, { headers: CORS });
      const claimed = await getClaimedRewards(uid);
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
        ok = (await getClaimedRewards(uid)).includes(key);   // 須已領取（非僅集滿）
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
        if (!(await getClaimedRewards(uid)).includes(key)) return Response.json({ kind: "err", msg: "此頭像尚未領取（集滿後至卦曆領取）" }, { headers: CORS });
        val = key;
      }
      await db.from("user_character").upsert({ user_id: uid, character_id: cid, avatar: val }, { onConflict: "user_id,character_id" });
      return Response.json({ kind: "ok", character_id: cid, avatar: val }, { headers: CORS });
    }

    // 載入聊天歷史（前端顯示用；記憶後端本就保存）
    if (body.mode === "chat_history") {
      // 取「最新」40 則（原本 ascending+limit 是取最舊 40）；
      // 同一問答常同 timestamp，補 role 排序鍵防配對翻轉（問在前、答在後）
      const { data: msgs } = await db.from("chat_messages").select("role, body")
        .eq("user_id", uid).eq("character_id", body.character_id)
        .order("created_at", { ascending: false })
        .order("role", { ascending: true })   // desc 串裡 assistant 在前，反轉後 user 在前
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

    // 靈石收支紀錄（近 30 天，新→舊，最多 100 筆；ledger 為終身流水，僅查詢時取窗）
    if (body.mode === "lingshi_log") {
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const { data: rows } = await db.from("ledger").select("action, amount, created_at")
        .eq("user_id", uid).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(100);
      return Response.json({ kind: "ok", logs: rows ?? [] }, { headers: CORS });
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
      const r = await chat(db, { userId: uid, characterId: body.character_id, message: String(body.message ?? "") });
      return Response.json({ kind: "ok", reply: r.reply, tier: r.tier, favorLeft: r.favorLeft, cost: r.cost, freeLeft: r.freeLeft, lingshiLeft: r.lingshiLeft, wantCast: r.wantCast }, { headers: CORS });
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
          await db.rpc("bump_plaza_unread", { p_user: tgt.user_id, p_delta: 1 });
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
      // 進「會員 › 廣場」即視為已看過被回覆通知，未讀清零（紅點消失）
      await db.from("profiles").update({ plaza_unread: 0 }).eq("id", uid);
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
      return Response.json({ kind: "ok", posts: entries }, { headers: CORS });
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
          userId: uid, quotaKey: body.quota_key ?? uid,
          characterId: body.character_id ?? "daoshi_m",
          question: body.question, channel: body.channel ?? "web",
          numbers: body.numbers, lines: body.lines, // ← 網頁傳已起好的卦
          yongQin: body.yong_qin, yongViaShi: body.yong_via_shi,
          castDate: parseCastDate(body.cast_date), // 手動排盤自填占時（無/不合法則後端用當下台北時）
        });
    return Response.json(result, { headers: CORS });
  } catch (e) {
    console.error(e);
    return new Response("internal error", { status: 500, headers: CORS });
  }
});
