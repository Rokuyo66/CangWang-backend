// dev/web/voice-player.js — 心跡・語音頁的播放器。
//
// 這是前端模組，但源頭放在後端 repo，理由與 case-play.js 相同：它與 voice_list
// 的回應形狀是綁死的（parts[].text、parts[].ms、peaks、duration_ms 都是伺服器算的），
// 契約改了這支就得跟著改。放在契約旁邊，改的人才會同時看到兩邊。
// 用法：複製到前端 repo 的 src/modules/voice-player.js，由心跡的語音分頁呼叫。
//
// 【一顆播放鈕要一次做四件事】
// 先前那一版只做了「開始放聲音」，於是按下去之後畫面上什麼都沒變：
// icon 還是三角形、字沒有攤開、沒有進度、不知道還剩多久。聲音在響，
// 但畫面看起來像壞掉——人只能盯著一顆沒有反應的圓圈猜它到底有沒有在動。
// 所以按下去必須同時：
//   一、icon 換成暫停；
//   二、把念的字攤開來，念到哪一段哪一段是墨色；
//   三、波形填成進度，整條可按，按哪裡跳哪裡；
//   四、右邊說**還剩**幾秒，不是只說總長。
//
// 【只有一個 <audio>】
// 一張卡一個 audio 的話，連按兩張就是兩段聲音一起響，而且第一張的 icon
// 永遠回不到播放鍵（沒有人會去通知它）。整頁共用一個，換卡就是換 src——
// 「同時只有一段在播」這件事就不必靠任何一處記得去關掉別人。
//
// 【一則收藏是好幾個音檔】
// 長批文在伺服器切過段，角色台詞與旁白還會換嗓子，所以 parts 是一串要接著
// 播完的檔。進度與剩餘秒數都以「整則」為單位算，不是這一個檔——否則播到
// 第二段時進度條會跳回開頭。

const NS = "vp";

/* ── 長度：先用估的，量到真的就換掉 ────────────────────────────────
   parts[].ms 是伺服器由字數估的（字數 ÷ 每秒 4.5 字）。估的會差幾秒，
   而差幾秒在「還剩 1:19」上看得出來。所以音檔一載入 metadata 就把真值
   記下來，之後都用真值——不為了求準去預載每一個檔，那等於把整頁的音檔
   都下載一遍，而人多半只聽其中一則。 */
const realMs = new Map();               // url → 真實毫秒
const msOf = (part) => realMs.get(part.url) ?? part.ms ?? 0;
const totalMs = (clip) => clip.parts.reduce((n, p) => n + msOf(p), 0);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** 0:48。負數與 NaN 一律當 0——時間欄位是最不該出現 "NaN:aN" 的地方。 */
function clock(ms) {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ── 波形 ────────────────────────────────────────────────────────
   高度來自 clip.peaks（伺服器由內容指紋展開：每則各有各的樣子、每次打開
   都一樣）。它不是量出來的振幅——真波形要把整個 mp3 抓下來解碼，為了一排
   裝飾條下載幾 MB 不划算。所以別把它標成音量，它只是「這是一段聲音」的樣子。
   舊的收藏可能沒有 peaks（伺服器補得回來，但別賭），沒有就給一排等高的。 */
const FALLBACK = Array.from({ length: 44 }, (_, i) => 30 + ((i * 37) % 45));

function waveHtml(peaks) {
  const bars = (peaks && peaks.length ? peaks : FALLBACK);
  const step = 300 / bars.length;
  const w = Math.max(2, Math.min(3.4, step - 3.4));
  const rects = bars.map((p, i) => {
    const h = Math.max(3, clamp(p, 0, 100) / 100 * 30);
    return `<rect x="${(i * step).toFixed(2)}" y="${((34 - h) / 2).toFixed(2)}" `
      + `width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1.5"></rect>`;
  }).join("");
  // clipPath 是關鍵：金色那一層與灰色那一層是同一排柱子，用一個會動的
  // 矩形把金色裁到現在這一刻。逐根切換 class 的話，44 根 × 每秒 60 次
  // 就是每秒兩千多次 class 操作，中階手機上會掉幀。
  return `<svg class="${NS}-wave" viewBox="0 0 300 34" width="100%" height="34"
      preserveAspectRatio="none" role="img" aria-label="播放進度">
    <defs><clipPath id="__CLIP__"><rect class="${NS}-mask" x="0" y="0" width="0" height="34"></rect></clipPath></defs>
    <g class="${NS}-off">${rects}</g>
    <g class="${NS}-on" clip-path="url(#__CLIP__)">${rects}</g>
    <rect class="${NS}-head" x="0" y="2" width="1.4" height="30" rx="0.7"></rect>
  </svg>`;
}

/* ── 一張卡 ───────────────────────────────────────────────────── */

function cardHtml(clip, i) {
  const id = `${NS}-c${i}`;
  const says = clip.parts.map((p) => p.text
    ? `<p class="${NS}-say${p.narrator ? ` ${NS}-nar` : ""}">${esc(p.text)}</p>`
    : "").join("");
  // 逐字稿補不回來的那幾則（那一卦刪了，見 voice.ts 的 backfillTexts）：
  // 不留一塊空白，說一句話——空白會被當成「又壞了」。
  const body = says.trim() ? says
    : `<p class="${NS}-say ${NS}-none">這一段的原文找不回來了（當初那一卦已經刪了）。聲音還在，照樣聽得完。</p>`;

  return `<article class="${NS}-card" data-i="${i}">
    <div class="${NS}-head-row">
      <!-- 頭像：正式接的時候換成 clip.character_id 對應的立繪（前端資產）。
           這裡取卦名第一個字只是備援，免得沒有圖時空一個洞。 -->
      <div class="${NS}-face" data-character="${esc(clip.character_id || "")}" aria-hidden="true">${esc((clip.title || "解").replace(/[《》]/g, "").slice(0, 1))}</div>
      <div class="${NS}-meta">
        <div class="${NS}-title">${esc(clip.title || "解卦")}</div>
        <div class="${NS}-sub"><span class="${NS}-q">${esc(clip.subtitle || "")}</span><span class="${NS}-len">${clock(totalMs(clip))}</span></div>
      </div>
      <button class="${NS}-btn" type="button" aria-label="播放" aria-expanded="false" aria-controls="${id}">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M8 5.5v13l11-6.5Z"></path></svg>
      </button>
    </div>
    <div class="${NS}-open" id="${id}" hidden>
      ${waveHtml(clip.peaks).replace(/__CLIP__/g, `${NS}-clip-${i}`)}
      <div class="${NS}-times"><span class="${NS}-at">0:00</span><span class="${NS}-left">剩 ${clock(totalMs(clip))}</span></div>
      <div class="${NS}-text">${body}</div>
      <button class="${NS}-fold" type="button">收起 ∧</button>
    </div>
  </article>`;
}

/* ── 掛上去 ───────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} root  要畫在哪裡（內容會被覆蓋）
 * @param {{clips:Array}} payload  voice_list 的回應
 * @returns {{stop:()=>void}} 離開這一頁時呼叫 stop()——不呼叫的話，
 *   切到別的分頁聲音還會繼續響，而畫面上已經沒有任何一顆鈕能停它。
 */
export function mountVoicePlayer(root, payload) {
  const clips = (payload?.clips ?? []).map((c) => ({ ...c, parts: c.parts ?? [] }));
  injectStyle();
  root.innerHTML = `<div class="${NS}-list">${clips.map(cardHtml).join("")}</div>`;

  const cards = [...root.querySelectorAll(`.${NS}-card`)];
  const audio = new Audio();
  audio.preload = "metadata";

  let cur = -1;          // 正在播第幾則（-1＝沒有）
  let part = 0;          // 那一則的第幾個音檔
  let raf = 0;

  // 一張卡的節點只找一次。進度是每秒六十次在畫的，每一次都重新
  // querySelector 一輪，中階手機上就是這裡開始掉幀。
  const cache = cards.map((el) => ({
    el,
    open: el.querySelector(`.${NS}-open`),
    btn: el.querySelector(`.${NS}-btn`),
    icon: el.querySelector(`.${NS}-btn svg`),
    mask: el.querySelector(`.${NS}-mask`),
    headBar: el.querySelector(`.${NS}-head`),
    at: el.querySelector(`.${NS}-at`),
    left: el.querySelector(`.${NS}-left`),
    len: el.querySelector(`.${NS}-len`),
    says: [...el.querySelectorAll(`.${NS}-say`)],
    wave: el.querySelector(`.${NS}-wave`),
    pct: -1,
  }));
  const refs = (i) => cache[i];

  const PLAY = '<path d="M8 5.5v13l11-6.5Z"></path>';
  const PAUSE = '<rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect>';

  /** icon 與 aria 一起換。只換圖不換 aria-label，讀螢幕的人會一直聽到「播放」。 */
  function paintButton(i, playing) {
    const r = refs(i);
    r.icon.innerHTML = playing ? PAUSE : PLAY;
    r.btn.setAttribute("aria-label", playing ? "暫停" : "播放");
    r.el.classList.toggle(`${NS}-on-air`, playing);
  }

  function expand(i, yes) {
    const r = refs(i);
    r.open.hidden = !yes;
    r.btn.setAttribute("aria-expanded", String(!!yes));
  }

  /** 這一則到現在為止播了多久（毫秒）。以整則為單位——播到第二段時
   *  進度不該跳回開頭。 */
  function elapsedOf(i) {
    const c = clips[i];
    let ms = 0;
    for (let k = 0; k < part; k++) ms += msOf(c.parts[k]);
    return ms + (Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0);
  }

  function paintProgress(i) {
    const c = clips[i], r = refs(i);
    const total = totalMs(c) || 1;
    const at = clamp(elapsedOf(i), 0, total);
    const ratio = at / total;
    r.mask.setAttribute("width", (ratio * 300).toFixed(2));
    r.headBar.setAttribute("x", (ratio * 300).toFixed(2));
    r.at.textContent = clock(at);
    r.left.textContent = `剩 ${clock(total - at)}`;
    // aria-label 只在整數百分比變了才寫：每秒改六十次屬性，讀螢幕的人
    // 會被洗版，而他要的只是「大概到哪裡了」。
    const pct = Math.round(ratio * 100);
    if (pct !== r.pct) { r.pct = pct; r.wave.setAttribute("aria-label", `播放進度 ${pct}%`); }
    for (let k = 0; k < r.says.length; k++) {
      r.says[k].classList.toggle(`${NS}-said`, k < part);
      r.says[k].classList.toggle(`${NS}-now`, k === part);
    }
  }

  function tick() {
    if (cur >= 0 && !audio.paused) { paintProgress(cur); raf = requestAnimationFrame(tick); }
    else raf = 0;
  }
  const follow = () => { if (!raf) raf = requestAnimationFrame(tick); };

  // 換了 src 之後有一小段時間是 paused（還在載），那一刻 tick 會自己收工。
  // 所以真的開始響的時候要再叫它一次——少了這一行，跳段之後進度條就停在
  // 原地不動，而聲音其實正在播。
  audio.addEventListener("play", follow);
  audio.addEventListener("playing", follow);
  audio.addEventListener("timeupdate", () => { if (cur >= 0 && !raf) paintProgress(cur); });

  /** 把一張卡的進度歸零。切到別則、或整則播完時用——
   *  離開的那一張若留著半條金色，人下次按下去會從頭播，畫面卻說在中間。 */
  function resetCard(i) {
    const r = refs(i);
    r.mask.setAttribute("width", "0");
    r.headBar.setAttribute("x", "0");
    r.pct = -1;
    r.at.textContent = "0:00";
    r.left.textContent = `剩 ${clock(totalMs(clips[i]))}`;
    r.says.forEach((x) => x.classList.remove(`${NS}-said`, `${NS}-now`));
  }

  /** 換到某一則的某一段。offset 是那一段之內的秒數。 */
  function load(i, p, offset = 0, play = true) {
    part = p;
    audio.src = clips[i].parts[p].url;      // 換 src 本來就會把 currentTime 歸零
    const go = () => {
      if (offset) { try { audio.currentTime = offset; } catch { /* 還不能設就算了 */ } }
      if (play) audio.play().catch(() => paintButton(i, false));
    };
    if (offset) audio.addEventListener("loadedmetadata", go, { once: true });
    else go();
  }

  function stop(silent) {
    if (cur < 0) return;
    audio.pause();
    const was = cur;
    if (!silent) { paintButton(was, false); paintProgress(was); }
    cur = -1; part = 0;
  }

  function start(i) {
    if (cur === i) {                       // 同一則：暫停／續播，不從頭來
      if (audio.paused) { audio.play().catch(() => {}); paintButton(i, true); follow(); }
      else { audio.pause(); paintButton(i, false); }
      return;
    }
    if (cur >= 0) { paintButton(cur, false); audio.pause(); resetCard(cur); }   // 只有一段在播
    cur = i;
    expand(i, true);                       // 按播放＝連字一起攤開
    load(i, 0, 0, true);
    paintButton(i, true);
    paintProgress(i);
    follow();
  }

  /** 按波形跳到那一刻：整則的時間軸，先找是哪一段，再算段內的秒數。 */
  function seek(i, ratio) {
    const c = clips[i];
    let target = clamp(ratio, 0, 0.999) * totalMs(c);
    let p = 0;
    while (p < c.parts.length - 1 && target > msOf(c.parts[p])) { target -= msOf(c.parts[p]); p++; }
    if (cur !== i) { cur = i; expand(i, true); paintButton(i, true); }
    load(i, p, target / 1000, true);
    paintProgress(i);
    follow();
  }

  audio.addEventListener("ended", () => {
    if (cur < 0) return;
    const c = clips[cur];
    if (part + 1 < c.parts.length) { load(cur, part + 1, 0, true); return; }  // 接著播下一段
    // 整則播完：回到起點、icon 回播放鍵，字留著不收起——人常常要再聽一次。
    const done = cur;
    audio.pause(); cur = -1; part = 0;
    paintButton(done, false);
    resetCard(done);
  });

  // 真實長度一量到就記下來，之後的秒數都用真的（估的差幾秒看得出來）
  audio.addEventListener("loadedmetadata", () => {
    if (cur < 0 || !Number.isFinite(audio.duration)) return;
    realMs.set(clips[cur].parts[part].url, audio.duration * 1000);
    if (refs(cur).len) refs(cur).len.textContent = clock(totalMs(clips[cur]));
    paintProgress(cur);
  });

  // 檔案掛了（網路斷、檔被清掉）：把鈕放回去並說一句，不要卡在暫停的樣子
  audio.addEventListener("error", () => {
    if (cur < 0) return;
    const bad = cur; stop(true); paintButton(bad, false);
    refs(bad).left.textContent = "聽不到，換個網路再試";
  });

  root.addEventListener("click", (ev) => {
    const card = ev.target.closest?.(`.${NS}-card`);
    if (!card) return;
    const i = Number(card.dataset.i);
    if (ev.target.closest(`.${NS}-btn`)) { start(i); return; }
    if (ev.target.closest(`.${NS}-fold`)) { expand(i, false); return; }
    const wave = ev.target.closest(`.${NS}-wave`);
    if (wave) {
      const box = wave.getBoundingClientRect();
      seek(i, (ev.clientX - box.left) / box.width);
      return;
    }
    // 卡身其餘地方＝只開合，不動聲音。播著的時候收起來，icon 仍是暫停——
    // 展開與播放是兩件事，混在一起就會出現「收起來之後停不掉」。
    expand(i, refs(i).open.hidden);
  });

  return {
    stop: () => { stop(true); cancelAnimationFrame(raf); raf = 0; audio.src = ""; },
  };
}

/* ── 樣式 ────────────────────────────────────────────────────────
   色票走心跡那一套（宣紙暖白），全部走 CSS 變數，宿主要換皮直接蓋。 */
let styled = false;
function injectStyle() {
  if (styled || document.getElementById(`${NS}-style`)) { styled = true; return; }
  const el = document.createElement("style");
  el.id = `${NS}-style`;
  el.textContent = `
.${NS}-list{--vp-paper:#F7F3EA;--vp-card:#FFFDF8;--vp-line:#E0D5BF;--vp-rule:#EDE6D7;
  --vp-ink:#3A322A;--vp-sub:#8A7C68;--vp-dim:#B5A88F;--vp-gold:#B08A4A;--vp-wave:#D9C79C;
  display:flex;flex-direction:column;gap:14px}
.${NS}-card{background:var(--vp-card);border:1px solid var(--vp-line);border-radius:14px;
  padding:14px 16px;box-shadow:0 1px 0 rgba(58,50,42,.04),0 6px 16px -12px rgba(58,50,42,.35)}
.${NS}-card.${NS}-on-air{background:#FDF9F0;border-color:var(--vp-wave)}
.${NS}-head-row{display:flex;align-items:center;gap:12px}
.${NS}-face{width:40px;height:40px;flex-shrink:0;border-radius:50%;background:#CFC0A2;
  display:flex;align-items:center;justify-content:center;font-size:15px;color:#463c2c}
.${NS}-meta{flex:1;min-width:0}
.${NS}-title{font-size:15px;color:var(--vp-ink)}
/* 秒數不能跟著問句一起被切掉——被切掉的話，收起來的卡就完全看不出這段多長。
   問句自己省略，秒數固定佔一格。 */
.${NS}-sub{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--vp-sub)}
.${NS}-q{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${NS}-len{flex-shrink:0;color:var(--vp-dim);font-variant-numeric:tabular-nums}
.${NS}-btn{width:44px;height:44px;flex-shrink:0;border-radius:50%;background:var(--vp-card);
  border:1px solid var(--vp-line);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
.${NS}-btn svg{fill:var(--vp-gold)}
.${NS}-on-air .${NS}-btn{background:var(--vp-gold);border-color:var(--vp-gold)}
.${NS}-on-air .${NS}-btn svg{fill:var(--vp-card)}
.${NS}-open{margin-top:13px}
.${NS}-wave{display:block;cursor:pointer;touch-action:manipulation}
.${NS}-off rect{fill:var(--vp-wave)}
.${NS}-on rect{fill:var(--vp-gold)}
.${NS}-head{fill:var(--vp-ink)}
.${NS}-times{display:flex;justify-content:space-between;font-size:11px;color:var(--vp-dim);
  margin-top:3px;font-variant-numeric:tabular-nums}
.${NS}-at{color:var(--vp-sub)}
.${NS}-text{margin-top:13px;padding-top:13px;border-top:1px solid var(--vp-rule)}
.${NS}-say{margin:0 0 9px;font-size:14.5px;line-height:1.9;color:var(--vp-dim);transition:color .2s}
.${NS}-say.${NS}-said{color:var(--vp-sub)}
.${NS}-say.${NS}-now{color:var(--vp-ink)}
.${NS}-nar{padding-left:14px;border-left:2px solid var(--vp-rule);font-size:13.5px}
.${NS}-nar.${NS}-now{color:var(--vp-sub)}
.${NS}-none{font-size:13px;color:var(--vp-dim)}
.${NS}-fold{display:block;margin:2px auto 0;background:none;border:none;padding:6px 10px;
  font-size:11px;letter-spacing:.1em;color:var(--vp-dim);cursor:pointer}
@media (prefers-reduced-motion:reduce){.${NS}-say{transition:none}}
`;
  document.head.appendChild(el);
  styled = true;
}
