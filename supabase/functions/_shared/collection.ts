// _shared/collection.ts — 卦鑑：誰收過哪些卦、集滿哪一行、哪些獎勵頭像已到手。
//
// 收集度來自 gua_collection（0051 建的永久表），不再從 casts 現算。
// 現算的兩個致命處已經在線上咬過人：PostgREST 的 db-max-rows 會把超過一千筆之後的卦
// 切掉，刪一則問卦紀錄會連著把那一卦從鑑裡抹掉——兩者都讓收集度倒退，
// 而倒退會把玩家已經領到手的獎勵頭像鎖回去。收過的卦只增不減，這裡是那個承諾的實作。
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { GUA_BY_UPPER } from "./core.ts";
import { FORTUNE_CATEGORY } from "./rules.ts";

// 上卦行順序（卦曆一行八卦，八行六十四卦）
export const UP_ORDER = ["乾", "兌", "離", "震", "巽", "坎", "艮", "坤"];
// 上卦行 → 獎勵頭像 key（集滿該行達成）；全 64 另給 r11/r12/r13
export const REWARD_BY_UPPER: Record<string, string[]> = {
  乾: ["r01"], 兌: ["r02"], 離: ["r03"], 震: ["r04"],
  巽: ["r05"], 坎: ["r06"], 艮: ["r07", "r08"], 坤: ["r09", "r10"],
};
// 御三家換裝：角色 → {獎勵key: 上卦行 或 "ALL"}（達成=集滿該行/全64）
export const CHAR_REWARDS: Record<string, Record<string, string>> = {
  daoshi_m: { r01: "乾", r04: "震", r11: "ALL" },
  daoshi_f: { r02: "兌", r05: "巽", r12: "ALL" },
  lingshou: { r03: "離", r06: "坎", r13: "ALL" },
};
export const PLAYER_REWARDS = ["r07", "r08", "r09", "r10"]; // 玩家池獎勵（其餘 01~06/11~13 屬御三家換裝）

// 一次撈幾列。Supabase 的 db-max-rows 預設就是 1000，設得比它大沒有意義；
// 迴圈以「這一頁回了幾列」推進，所以就算伺服器把上限調小也不會漏頁。
const PAGE = 1000;

/** 把這幾卦收進卦鑑（永久）。已收過的原樣不動。 */
export async function recordGua(db: SupabaseClient, userId: string, names: (string | null | undefined)[]) {
  const rows = [...new Set(names.filter((n): n is string => !!n))].map((gua) => ({ user_id: userId, gua }));
  if (!rows.length) return;
  const { error } = await db.from("gua_collection")
    .upsert(rows, { onConflict: "user_id,gua", ignoreDuplicates: true });
  // 收卦失敗不該讓起卦失敗（卦錢已扣、批文已出）。漏掉的那一卦由 syncGuaFromCasts 補回。
  if (error) console.error("recordGua failed", error.message);
}

/** 卦鑑裡已收的卦名（一人最多 64 列，一次撈完）。
 *  表還沒建（migration 未套、或函式先於 migration 上線）時退回現算——
 *  那正是這一版要修掉的舊行為，但「暫時算得少一點」遠好過「整本卦鑑變 0/64」。 */
export async function collectedGua(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const t = await readCollection(db, userId);
  return t.ok ? t.gua : await guaFromCasts(db, userId);
}

async function readCollection(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("gua_collection").select("gua").eq("user_id", userId);
  if (error) {
    console.error("read gua_collection failed, fall back to casts", error.message);
    return { ok: false, gua: new Set<string>() };
  }
  return { ok: true, gua: new Set((data ?? []).map((r: { gua: string }) => r.gua)) };
}

/** 從 casts 現算收過哪些卦（分頁掃）。
 *  不分頁的話會被 db-max-rows 切掉——起卦破千之後，落在視窗外的卦就從卦鑑上消失，
 *  收集度會隨著「用得越多」而縮水。這支只讀不寫。 */
async function guaFromCasts(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const derived = new Set<string>();
  for (let page = 0, from = 0; page < 100; page++) {
    const { data, error } = await db.from("casts")
      .select("gua_ben, gua_bian, category").eq("user_id", userId)
      .order("created_at", { ascending: true }).order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("scan casts for gua failed", error.message); break; }
    if (!data?.length) break;
    for (const r of data as { gua_ben: string | null; gua_bian: string | null; category: string | null }[]) {
      // 日運卦不入鑑：那是每日免費贈的今日氣象，不該拿來刷 64 卦收集進度
      if (r.category === FORTUNE_CATEGORY) continue;
      if (r.gua_ben) derived.add(r.gua_ben);
      if (r.gua_bian) derived.add(r.gua_bian);
    }
    from += data.length;                 // 以「這一頁回了幾列」推進，伺服器上限調小也不漏頁
  }
  return derived;
}

/** 自癒：把 casts 裡有、卦鑑漏掉的卦補回去，回傳補完後的完整集合。
 *  0051 的回填已經做過一次，這裡是給「回填之後才發生的漏寫」兜底
 *  （起卦當下 recordGua 失敗、或走了別條沒有記錄的入庫路徑）。 */
export async function syncGuaFromCasts(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const t = await readCollection(db, userId);
  const derived = await guaFromCasts(db, userId);
  if (!t.ok) return derived;             // 表都讀不到，寫也不會成功，直接回現算的
  const missing = [...derived].filter((g) => !t.gua.has(g));
  if (missing.length) {
    await recordGua(db, userId, missing);
    for (const g of missing) t.gua.add(g);
  }
  return t.gua;
}

/** 收集狀態：各上卦行進度、集滿「達成」的獎勵 key。
 *  注意：eligible 是「集滿達成」，不是「已解鎖可用」——集滿後須玩家至卦曆點擊領取
 *  （claim_reward）寫入 profiles.claimed_rewards，才是真正到手。
 *  已到手的不會因為這裡的達成狀態變動而收回，見 rewardState()。
 *  heal=true 時順手對一次 casts（卦曆／領獎那幾支用；開 App 的 profile 不必為此掃全表）。 */
export async function computeCollection(db: SupabaseClient, userId: string, heal = false) {
  const owned = heal ? await syncGuaFromCasts(db, userId) : await collectedGua(db, userId);
  const columns = UP_ORDER.map((up) => {
    const names = GUA_BY_UPPER[up] ?? [];
    const got = names.filter((n) => owned.has(n));
    const done = names.length > 0 && got.length === names.length;
    return { up, names, owned: got, count: got.length, total: names.length, done, rewards: REWARD_BY_UPPER[up] ?? [] };
  });
  const allDone = columns.every((c) => c.done);
  const eligible: string[] = [];
  for (const c of columns) if (c.done) eligible.push(...c.rewards);
  if (allDone) eligible.push("r11", "r12", "r13");
  return { owned, columns, allDone, eligible };
}

/** 已領取的獎勵頭像 key（真正解鎖可用的集合） */
export async function claimedRewards(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await db.from("profiles").select("claimed_rewards").eq("id", userId).maybeSingle();
  return (data?.claimed_rewards ?? []) as string[];
}

/** 前端畫鎖頭要的兩份名單。
 *  unlocked 一律是「已領取」的全部——領過就是玩家的，不再與當下的集滿狀態相乘。
 *  （舊版是 eligible ∩ claimed：收集度一旦倒退，已經戴在身上的頭像會在道籍變回鎖頭。） */
export function rewardState(eligible: string[], claimed: string[]) {
  const has = new Set(claimed);
  return { unlocked: [...has], claimable: eligible.filter((k) => !has.has(k)) };
}
