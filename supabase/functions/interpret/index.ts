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

// 收集狀態：distinct gua_ben(＋gua_bian) → 各上卦行進度、已解鎖獎勵
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

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
    const body = await req.json();
    // 網頁(JWT)路徑：user_id 一律用 JWT 解出的，忽略前端傳的 body.user_id（安全鐵則）
    const uid = jwtUserId ?? body.user_id;
    if (!uid) return new Response("no user", { status: 400, headers: CORS });

    // 查個人狀態：靈石、暱稱、各角色好感/境界、應期未回評數（紅點）
    if (body.mode === "profile") {
      const { data: prof } = await db.from("profiles").select("lingshi, display_name, last_sign_date, selected_avatar, signin_total").eq("id", uid).maybeSingle();
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
      return Response.json({ kind: "ok", lingshi: prof?.lingshi ?? 0, display_name: prof?.display_name ?? null, favors, realms, cults, charAvatars, dueUnreviewed, chatFreeLeft, chatCost: COST_CHAT, signedToday, selected_avatar: prof?.selected_avatar ?? null, ahUnlocked: ahUnlockedCount(prof?.signin_total ?? 0) }, { headers: CORS });
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

    // 圖鑑收集 + 上卦行獎勵解鎖狀態
    if (body.mode === "collection") {
      const { columns, allDone, unlocked } = await computeCollection(uid);
      const ownedCount = columns.reduce((s, c) => s + c.count, 0);
      return Response.json({ kind: "ok", columns, allDone, unlocked, ownedCount }, { headers: CORS });
    }

    // 設定玩家頭像（a~h 依解鎖數；r07~r10 需已解鎖。御三家 01~06/11~13 不屬玩家池）
    if (body.mode === "set_avatar") {
      const key = String(body.avatar ?? "");
      let ok = false;
      if (/^[a-h]$/.test(key)) {
        const { data: prof } = await db.from("profiles").select("signin_total").eq("id", uid).maybeSingle();
        ok = AH_KEYS.indexOf(key) < ahUnlockedCount(prof?.signin_total ?? 0);
      } else if (PLAYER_REWARDS.includes(key)) {
        const { unlocked } = await computeCollection(uid);
        ok = unlocked.includes(key);
      }
      if (!ok) return Response.json({ kind: "err", msg: "頭像未解鎖" }, { headers: CORS });
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
        const { unlocked } = await computeCollection(uid);
        if (!unlocked.includes(key)) return Response.json({ kind: "err", msg: "此頭像尚未解鎖" }, { headers: CORS });
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
        .select("id, question, gua_ben, gua_bian, created_at, due_date, character_id, feedback(verdict)")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(60);
      return Response.json({ kind: "ok", casts: casts ?? [] }, { headers: CORS });
    }

    // 重溫單卦（含追問串）
    if (body.mode === "cast_detail") {
      const { data: c } = await db.from("casts")
        .select("id, question, chart, reading, deep_reading, gua_ben, gua_bian, created_at, due_date, character_id, yong_qin, yong_via_shi, feedback(verdict)")
        .eq("id", body.cast_id).eq("user_id", uid).maybeSingle();
      if (!c) return Response.json({ kind: "not_found" }, { headers: CORS });
      const { data: fus } = await db.from("followups").select("question, answer, created_at")
        .eq("cast_id", body.cast_id).order("created_at", { ascending: true });
      return Response.json({ kind: "ok", cast: c, followups: fus ?? [] }, { headers: CORS });
    }

    // 應期回評：1準 2部分 3不準（回評後修為+50，紅點消）
    if (body.mode === "review") {
      const v = Number(body.verdict);
      if (![1, 2, 3].includes(v)) return Response.json({ kind: "err" }, { headers: CORS });
      const { data: c } = await db.from("casts").select("character_id").eq("id", body.cast_id).eq("user_id", uid).maybeSingle();
      if (!c) return Response.json({ kind: "not_found" }, { headers: CORS });
      await db.from("feedback").upsert({ cast_id: body.cast_id, user_id: uid, verdict: v, answered_at: new Date().toISOString() }, { onConflict: "cast_id" });
      const { data: uc } = await db.from("user_character").select("cultivation").eq("user_id", uid).eq("character_id", c.character_id).maybeSingle();
      await db.from("user_character").upsert({ user_id: uid, character_id: c.character_id, cultivation: (uc?.cultivation ?? 0) + 50 }, { onConflict: "user_id,character_id" });
      return Response.json({ kind: "ok" }, { headers: CORS });
    }

    // 閒聊（複用 chat()：Haiku→NVIDIA→罐頭、扣好感、scrubBilling、記憶滾動）
    if (body.mode === "chat") {
      const r = await chat(db, { userId: uid, characterId: body.character_id, message: String(body.message ?? "") });
      return Response.json({ kind: "ok", reply: r.reply, tier: r.tier, favorLeft: r.favorLeft, cost: r.cost, freeLeft: r.freeLeft, lingshiLeft: r.lingshiLeft, wantCast: r.wantCast }, { headers: CORS });
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
        });
    return Response.json(result, { headers: CORS });
  } catch (e) {
    console.error(e);
    return new Response("internal error", { status: 500, headers: CORS });
  }
});
