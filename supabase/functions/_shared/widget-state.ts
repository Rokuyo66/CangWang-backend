// _shared/widget-state.ts — 桌面小工具的單一狀態端點（mode:"widget"）
//
// 文案與配色表在 widget.ts（純的、前端也 import 得動）；這一支負責把它們
// 與帳號狀態兜成一份「一眼份量」的回應。刻意不做的事，比做的事重要：
//
//   ・不打第二支請求。小工具一天被系統喚醒數次（開機、解鎖、時鐘跳日），
//     不能像首頁那樣 profile ＋ collection ＋ jieqi 連打三支。一支回完。
//   ・不回額度。問卦鈕上不標「今日剩 N 卦」——觀主定的：桌面上先算帳會讓人不問。
//     castFreeLeft 那類欄位在這裡一個都不給，前端就算想標也標不出來。
//   ・不呼叫模型。行止（宜守／且行）由等第硬對應，見 widget.ts 的 STANCE。
//     模型每天講法不同，而桌面上要的是一個每次醒來都一樣的詞；
//     批文留在 App 裡，點 castId 進去才讀。
//   ・不寫國曆。電腦與手機都有系統日期，再印一次只是佔掉那行小字。
//     小字走農民曆那一套：丙午年丁酉月甲子日 ＋ 節氣。
//
// 「今日測過沒有」以 profiles.last_fortune_date 為準（與 dailyFortune 同一把閘）；
// 等第不另存欄位，而是把今日那一卦的 chart 撈回來重跑 fortuneTier——
// 它是純函式，同一張盤永遠同一個等第。為了小工具多開一個欄位、多兩處寫入、
// 再多一次 migration，換來的只是省一次 select。

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { dayGZi, gzName, monthGZi, xunKong, yearGZi } from "./core.ts";
import type { Chart } from "./core.ts";
import { jieqiOf } from "./jieqi.ts";
import type { JieqiInfo } from "./jieqi.ts";
import { fortuneTier } from "./fortune.ts";
import { pickQian, TIER_LABEL } from "./qian60.ts";
import type { QianTier } from "./qian60.ts";
import { FORTUNE_CATEGORY } from "./rules.ts";
import { nowTaipei } from "./pipeline.ts";
import { stanceOf, themeList } from "./widget.ts";
import type { StanceInfo, WidgetTheme } from "./widget.ts";

/* ---------- 狀態 ---------- */

export interface WidgetState {
  /** 農民曆式小字。國曆不給，前端也就印不出來。 */
  ganzhi: { year: string; month: string; day: string; kong: string; line: string };
  jieqi: JieqiInfo;
  sign: { done: boolean; streak: number };
  fortune:
    | { done: false; hint: string }
    | { done: true; castId: string | null; tier: QianTier | null; tierLabel: string | null;
        stance: StanceInfo | null; qian: { n: number; gz: string; poem: string[] } | null };
  themes: { owned: string[]; list: WidgetTheme[] };
  lingshi: number;
}

const FORTUNE_HINT = "今日的氣還沒測——先抽一卦，才知道是宜守還是且行。";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 台北今日 00:00 對應的 UTC 時刻（撈今日的卦用；casts.created_at 是 timestamptz） */
function taipeiDayStartUtc(): string {
  const t = new Date(Date.now() + 8 * 3600_000);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() - 8 * 3600_000).toISOString();
}

/** 小工具的全部狀態，一支請求回完。純讀，不寫任何一列。 */
export async function widgetState(
  db: SupabaseClient,
  p: { userId: string; themePrices: Record<string, number> },
): Promise<WidgetState> {
  // 曆日只取一次，干支與「今天」都從這同一組 y/m/d 來。
  // 各自 new Date() 的話，跨過台北 00:00 的那一瞬間兩者會指到不同的日子，
  // 而那正是小工具最常被喚醒的時刻之一（時鐘跳日）。
  const { y, m, d } = nowTaipei();
  const today = `${y}-${pad2(m)}-${pad2(d)}`;

  const { data: prof } = await db.from("profiles")
    .select("lingshi, last_sign_date, sign_streak, last_fortune_date, owned_themes")
    .eq("id", p.userId).maybeSingle();

  const dayIdx = dayGZi(y, m, d);
  const ganzhi = {
    year: gzName(yearGZi(y, m, d).idx),
    month: gzName(monthGZi(y, m, d)),
    day: gzName(dayIdx),
    kong: xunKong(dayIdx),
    line: "",
  };
  ganzhi.line = `${ganzhi.year}年${ganzhi.month}月${ganzhi.day}日`;

  const owned = (prof?.owned_themes ?? []) as string[];
  const fortuneDone = prof?.last_fortune_date === today;

  let fortune: WidgetState["fortune"] = { done: false, hint: FORTUNE_HINT };
  if (fortuneDone) {
    // 今日那一卦：撈回盤面重算等第。撈不到（極少見：閘門記了、卦卻沒進庫）
    // 就回 done 而等第留空，前端顯示「今日已測」並把人帶回 App，不假造一個等第。
    const { data: cast } = await db.from("casts")
      .select("id, chart")
      .eq("user_id", p.userId).eq("category", FORTUNE_CATEGORY)
      .gte("created_at", taipeiDayStartUtc())
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const chart = (cast?.chart ?? null) as Chart | null;
    if (chart) {
      const { tier } = fortuneTier(chart);
      const q = pickQian(tier, chart.ganzhi.day, chart.ben[chart.shi - 1].zhi);
      fortune = {
        done: true, castId: (cast!.id as string) ?? null, tier, tierLabel: TIER_LABEL[tier],
        stance: stanceOf(tier), qian: { n: q.n, gz: q.gz, poem: q.poem },
      };
    } else {
      fortune = { done: true, castId: (cast?.id as string) ?? null, tier: null, tierLabel: null, stance: null, qian: null };
    }
  }

  return {
    ganzhi,
    jieqi: jieqiOf(y, m, d),
    sign: { done: prof?.last_sign_date === today, streak: prof?.sign_streak ?? 0 },
    fortune,
    themes: { owned, list: themeList(owned, p.themePrices) },
    lingshi: prof?.lingshi ?? 0,
  };
}
