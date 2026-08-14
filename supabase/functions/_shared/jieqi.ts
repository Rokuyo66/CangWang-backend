// _shared/jieqi.ts — 二十四節氣（由太陽視黃經反推，不查表、任何年份皆可算）
// 精度：Meeus 低精度太陽位置，黃經誤差 < 0.01°（約 15 分鐘），用來定「哪一天」綽綽有餘。
// 用途：每日提醒的開場句。節氣句為本專案自撰（依節氣本義與物候意象），非引用特定典籍版本。

const RAD = Math.PI / 180;

function jdnOf(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** JD → 西曆 y/m/d（傳入之 JD 須已含所需時區偏移） */
function jdToDate(jd: number): { y: number; m: number; d: number } {
  const z = Math.floor(jd + 0.5);
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524, c = Math.floor((b - 122.1) / 365.25);
  const dd = Math.floor(365.25 * c), e = Math.floor((b - dd) / 30.6001);
  const day = Math.floor(b - dd - Math.floor(30.6001 * e));
  const m = e < 14 ? e - 1 : e - 13;
  return { y: m > 2 ? c - 4716 : c - 4715, m, d: day };
}

/** 太陽視黃經（度，0~360） */
function sunLongitude(jd: number): number {
  const T = (jd - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * RAD;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  const omega = (125.04 - 1934.136 * T) * RAD;
  const lam = L0 + C - 0.00569 - 0.00478 * Math.sin(omega);
  return ((lam % 360) + 360) % 360;
}

/** 求太陽黃經達 deg 之時刻（JD）。黃經日增約 0.9856°，牛頓迭代數次即收斂。 */
function solarTermJD(deg: number, guessJD: number): number {
  let jd = guessJD;
  for (let i = 0; i < 8; i++) {
    let diff = sunLongitude(jd) - deg;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) < 1e-6) break;
    jd -= diff / 0.9856;
  }
  return jd;
}

// 依黃經排序：index i ↔ 黃經 i×15°（0°＝春分）
const TERMS = [
  "春分", "清明", "穀雨", "立夏", "小滿", "芒種", "夏至", "小暑", "大暑", "立秋", "處暑", "白露",
  "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至", "小寒", "大寒", "立春", "雨水", "驚蟄",
];

// 交節當日語（點出該節氣本義）／節氣期間語（{n}＝入此節氣第幾日）
const TERM_TEXT: Record<string, { onDay: string; daily: string }> = {
  立春: { onDay: "今日立春。一年之氣自此始，東風解凍、蟄蟲始振——舊帳未清，新局已開。", daily: "立春第{n}日，寒未盡而春已動。" },
  雨水: { onDay: "今日雨水。天一生水，潤物無聲；急不得的事，此時最宜慢慢養。", daily: "雨水第{n}日，凍解冰消，草木萌動。" },
  驚蟄: { onDay: "今日驚蟄。一聲雷起，蟄蟲皆出——藏了整個冬天的事，該動了。", daily: "驚蟄第{n}日，雷發聲，桃始華。" },
  春分: { onDay: "今日春分。晝夜各半、寒暑均平——最宜校準：問問自己是不是偏了。", daily: "春分第{n}日，日夜平分，玄鳥歸來。" },
  清明: { onDay: "今日清明。氣清景明，慎終追遠；要掃的不只是墓前，還有心裡的積塵。", daily: "清明第{n}日，天清地明，桐始華。" },
  穀雨: { onDay: "今日穀雨。雨生百穀，播下去的才算數——此時不種，秋日無收。", daily: "穀雨第{n}日，雨潤百穀，萍始生。" },
  立夏: { onDay: "今日立夏。萬物至此皆長大，勢已成形；該收的心收，該放的手放。", daily: "立夏第{n}日，螻蟈鳴，王瓜生。" },
  小滿: { onDay: "今日小滿。小得盈滿而未全熟——月盈則虧，留三分餘地最穩。", daily: "小滿第{n}日，苦菜秀，麥氣初盈。" },
  芒種: { onDay: "今日芒種。有芒之穀可種，一年最忙一節；此時的辛苦，是替後半年攢的。", daily: "芒種第{n}日，螳螂生，反舌無聲。" },
  夏至: { onDay: "今日夏至。陽極之日，晝最長——極盛之處便是轉折，盛時要防衰。", daily: "夏至第{n}日，鹿角解，蟬始鳴。" },
  小暑: { onDay: "今日小暑。溫風至，暑氣未極；煩躁多半從熱來，先靜心再論事。", daily: "小暑第{n}日，溫風至，蟋蟀居壁。" },
  大暑: { onDay: "今日大暑。一年最熱，濕熱交蒸——熬得過去，秋涼自來。", daily: "大暑第{n}日，腐草為螢，土潤溽暑。" },
  立秋: { onDay: "今日立秋。梧桐一葉落，天下盡知秋——由盛轉收，該結算了。", daily: "立秋第{n}日，涼風至，白露生。" },
  處暑: { onDay: "今日處暑。暑氣至此而止，鷹乃祭鳥；躁氣退去，人也該定下來了。", daily: "處暑第{n}日，天地始肅，禾乃登。" },
  白露: { onDay: "今日白露。露凝而白，陰氣漸重——添衣如添備，凡事留後手。", daily: "白露第{n}日，鴻雁來，玄鳥歸。" },
  秋分: { onDay: "今日秋分。晝夜再度均平，陰陽相半——與春分同理，是這一年第二次校準的時機。", daily: "秋分第{n}日，雷始收聲，蟄蟲坯戶。" },
  寒露: { onDay: "今日寒露。露寒將凝，秋意已深；此時進退，宜緩不宜急。", daily: "寒露第{n}日，鴻雁來賓，菊有黃華。" },
  霜降: { onDay: "今日霜降。霜殺百草，秋之末節——收不回的就讓它去，別強留。", daily: "霜降第{n}日，草木黃落，蟄蟲咸俯。" },
  立冬: { onDay: "今日立冬。水始冰、地始凍，萬物收藏——藏不是停，是養。", daily: "立冬第{n}日，水始冰，地始凍。" },
  小雪: { onDay: "今日小雪。虹藏不見，天地閉塞；此時看不清是常態，別急著下判斷。", daily: "小雪第{n}日，虹藏不見，閉塞成冬。" },
  大雪: { onDay: "今日大雪。積陰為雪，天寒地凍——守得住的人，才等得到春。", daily: "大雪第{n}日，鶡鴠不鳴，荔挺出。" },
  冬至: { onDay: "今日冬至。陰極陽生，一陽來復——最暗的那一天，也是回頭的那一天。", daily: "冬至第{n}日，一陽初動，蚯蚓結。" },
  小寒: { onDay: "今日小寒。寒未至極而雁已北鄉；冷到這裡，離回暖也就不遠了。", daily: "小寒第{n}日，雁北鄉，鵲始巢。" },
  大寒: { onDay: "今日大寒。一年最後一節，寒極將春——舊歲收尾，該了的了一了。", daily: "大寒第{n}日，雞始乳，水澤腹堅。" },
};

export interface JieqiInfo {
  name: string;      // 節氣名
  dayIndex: number;  // 入此節氣第幾日（交節當日＝1）
  isToday: boolean;  // 今日是否正逢交節
  line: string;      // 給用戶看的一句
}

/** 查某個台北日期所處的節氣。y/m/d 為台北曆日。
 *  取樣時刻用「台北當日將盡」而非正午：曆法上交節當天就算該節氣第 1 日，
 *  不論交節時刻落在幾點；若以正午取樣，交節在午後的日子會被算成前一節氣。 */
export function jieqiOf(y: number, m: number, d: number): JieqiInfo {
  const jdnToday = jdnOf(y, m, d);
  const dayEnd = jdnToday - 0.5 + 16 / 24 - 1e-6;    // 台北當日 23:59:59（UT+8 → JD）
  const lam = sunLongitude(dayEnd);
  const i = Math.floor(lam / 15) % 24;
  const startJD = solarTermJD(i * 15, dayEnd);        // 本節氣交節時刻
  const s = jdToDate(startJD + 8 / 24);               // 交節之台北曆日
  const dayIndex = jdnToday - jdnOf(s.y, s.m, s.d) + 1;
  const name = TERMS[i];
  const t = TERM_TEXT[name];
  return {
    name, dayIndex, isToday: dayIndex === 1,
    line: dayIndex === 1 ? t.onDay : t.daily.replace("{n}", String(dayIndex)),
  };
}
