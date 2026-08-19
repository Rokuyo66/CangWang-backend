// dev/shared/play-ui.ts — 卦案可玩原型的畫面與接線（填表工具與獨立原型共用）。
//
// 完全不接 AI：所有文字都直接來自案件檔的文本槽，由 case-engine 依當局投射組裝。
// 這樣才驗得出骨架本身好不好玩——接了 AI 只會讓爛骨架看起來像回事。
//
// 搜索是假的：用按鈕代替自然語言輸入（規格書第四節的自由描述行動之後才做）。
//
// 從 dev/play/entry.ts 抽出來的：填表工具要能拿「當下這份草稿」直接開跑，
// 案件檔就不能再寫死成 HUANGCUN，必須由呼叫端傳進來。

import { buildChart, castCoins } from "../../supabase/functions/_shared/core.ts";
import { projectCase, type CaseState } from "../../supabase/functions/_shared/case.ts";
import { toCaseDef, validateCase, type CaseFile } from "../../supabase/functions/_shared/case-schema.ts";
import {
  startRun, applyAction, options, regionView, review, clockOf,
  COMPANION_NAME, type RunState, type ActionOption,
} from "../../supabase/functions/_shared/case-engine.ts";

/** 把原型掛到 root 上。返回／離開的鈕由呼叫端自己畫在外面，這支只管案子本身。 */
export function mountPlay(root: HTMLElement, CF: CaseFile) {
  const app = root;

  let chart: ReturnType<typeof buildChart> | null = null;
  let state: CaseState | null = null;
  let run: RunState | null = null;
  let companion: string | null = null;
  let showChart = false;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* ═══ 起卦：真隨機三枚銅錢 ×6，零 AI、零成本 ═══ */
  function cast() {
    const now = new Date();
    const hour = CF.entryHour ?? now.getHours();
    const { lines } = castCoins();
    chart = buildChart(lines, now.getFullYear(), now.getMonth() + 1, now.getDate(), hour);
    state = projectCase(chart, toCaseDef(CF));
  }

  /* ═══ 畫面 ═══ */

  function setupScreen(): string {
    const errs = validateCase(CF);
    const picks = [
      { id: null, name: "獨自前往", desc: "沒有人替你看你沒看見的那一半。" },
      { id: "daoshi_m", name: "師兄", desc: "古籍、符號、陣法、建築。走外圍：廢廟、山路、後山。" },
      { id: "daoshi_f", name: "師妹", desc: "人際、情緒、言語漏洞。走人多的地方：村口、主屋、村長家。" },
      { id: "lingshou", name: "觀喵", desc: "氣味、動物異常、禁忌。走陰處：井邊、臥房、古碑。" },
    ];
    return `
    <div class="wrap">
      <h1>${esc(CF.title)}</h1>
      <p class="q">${esc(CF.question)}</p>
      ${errs.length ? `<p class="err">案件檔有 ${errs.length} 項結構錯誤，先修：${esc(errs[0])}</p>` : ""}
      <h2>帶誰進去</h2>
      <div class="picks">
        ${picks.map((p) => `
          <button class="pick${companion === p.id ? " on" : ""}" data-pick="${p.id ?? ""}">
            <span class="pn">${esc(p.name)}</span>
            <span class="pd">${esc(p.desc)}</span>
          </button>`).join("")}
      </div>
      <h2>起卦</h2>
      <p class="hint">三枚銅錢擲六次，真隨機。卦不決定少女在哪——真相是寫死的；
         卦決定你從哪裡切進去、哪一區敞開、要付多少代價。</p>
      ${state ? guaPanel(state, true) : ""}
      <div class="row">
        <button class="big" data-act="cast">${state ? "重新起卦" : "起卦"}</button>
        ${state ? `<button class="big go" data-act="enter">進案</button>` : ""}
      </div>
    </div>`;
  }

  function guaPanel(st: CaseState, full: boolean): string {
    const k = st.key, sp = st.support;
    const rows = st.regions.slice().reverse().map((r) => {
      const rf = CF.regions.find((x) => x.pos === r.pos)!;
      const roles = r.roles.length ? r.roles.join("") : "";
      return `<tr>
        <td class="p">${r.pos}</td>
        <td>${esc(rf.name)}</td>
        <td class="mono">${esc(r.qin + r.zhi)}<span class="dim">(${esc(r.wx)})</span></td>
        <td class="dim">${esc(r.beast)}</td>
        <td class="dim">${esc(r.dir)}</td>
        <td class="role">${esc(roles)}</td>
        <td class="dim">${esc(r.moving ? "動" + (r.flux.length ? "·" + r.flux.join("·") : "") : r.anDong ? "暗動" : "")}</td>
        <td class="dim">${esc(r.tags.join("·"))}</td>
      </tr>`;
    }).join("");
    return `
    <div class="gua">
      <div class="ghead">
        <b>${esc(st.benName)}</b>${st.turnTo ? ` 之 <b>${esc(st.turnTo)}</b>` : ""}
        <span class="dim">（${esc(st.palace)}宮${esc(st.guaType)}）　主軸方位 ${esc(st.palaceDir)}${st.turnDir ? ` → 翻面 ${esc(st.turnDir)}` : ""}</span>
      </div>
      <div class="gline">
        用神<b>${esc(st.useQin)}</b> 落 <b>${k.pos ?? "不上卦"}</b> 區${k.hidden ? `（伏於 ${k.flyPos} 區飛神下·${esc(k.chuFu ?? "")}）` : ""}
        　旺衰 ${esc(k.wang ?? "-")}／${esc(k.grade)}
        　代價 <b class="acc acc-${st.access}">${st.access}</b>
      </div>
      <div class="gline dim">
        立足 ${st.startPos} 區　對手 ${st.rivalPos} 區　世用 ${esc(st.shiYong ?? "-")}　節奏 ${st.tempo}
        　元神(助) ${sp.yuanPos.join("、") || "無"}${sp.yuanActive ? "·發動" : ""}
        　忌神(阻) ${sp.jiPos.join("、") || "無"}${sp.jiStrong ? "·旺動" : sp.jiActive ? "·發動" : ""}
        ${st.omens.length ? "　" + esc(st.omens.join("、")) : ""}
      </div>
      ${full ? `<table class="gtab">${rows}</table>` : ""}
    </div>`;
  }

  // 當前可選行動。按鈕只帶索引，不把 JSON 塞進 HTML 屬性——
  // 屬性裡的雙引號會把 attribute 提前結束，按鈕會變成點了沒反應。
  let curOpts: ActionOption[] = [];

  function playScreen(): string {
    const st = state!, r = run!;
    const view = regionView(CF, st, r);
    const opts = options(CF, st, r);
    curOpts = opts;
    const items = r.clues.map((c) => CF.clues.find((x) => x.id === c)!).filter(Boolean);
    const held = items.filter((c) => c.kind === "item");
    const known = items.filter((c) => c.kind === "knowledge");

    const group = (kind: string) =>
      opts.map((o, i) => ({ o, i })).filter(({ o }) => o.action.kind === kind);
    const btn = ({ o, i }: { o: ActionOption; i: number }) => `
      <button class="act${o.note && o.note !== "已看過" && o.note !== "已談過" ? " warn" : ""}" data-opt="${i}">
        <span>${esc(o.label)}</span>
        <span class="cost">${o.cost ? "+" + o.cost + " 分" : ""}${o.note ? "　" + esc(o.note) : ""}</span>
      </button>`;

    return `
    <div class="game">
      <div class="left">
        <div class="bar">
          <span class="clock">${clockOf(r.minute)}</span>
          <span>${esc(view.name)}</span>
          <span class="dim">${esc(view.dir)}　${esc(view.beast)}·${esc(view.mood)}</span>
          ${view.roles.length ? `<span class="role">${esc(view.roles.join(""))}</span>` : ""}
          ${r.errand
            ? `<span class="l-world">${esc(COMPANION_NAME[r.companion!] ?? "")}外出中`
              + `·約 ${Math.max(0, r.errand.returnAt - r.minute)} 分後歸</span>`
            : ""}
          <button class="mini" data-act="togglegua">${showChart ? "收起卦盤" : "看卦盤"}</button>
        </div>
        ${showChart ? guaPanel(st, true) : ""}
        <div class="scene">
          ${view.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}
        </div>
        <div class="log" id="log">
          ${r.log.map((l) => `<p class="l l-${l.kind}"><span class="lt">${l.clock}</span>${esc(l.text)}</p>`).join("")}
        </div>
      </div>
      <div class="right">
        <div class="panel">
          <h3>此處</h3>
          ${group("search").map(btn).join("")}
          ${group("inspect").map(btn).join("")}
          ${group("talk").map(btn).join("")}
          ${group("companion").map(btn).join("")}
        </div>
        <div class="panel">
          <h3>移動　<span class="dim">每次 +5 分</span></h3>
          ${group("move").map(btn).join("")}
        </div>
        <div class="panel">
          <h3>手上（${held.length}）</h3>
          ${held.length ? held.map((c) => `<p class="itm">${esc(c.name)}</p>`).join("") : `<p class="dim">空的。</p>`}
          <h3>已看出（${known.length}／${CF.clues.filter((c) => c.kind === "knowledge").length}）</h3>
          ${known.length ? known.map((c) => `<p class="itm">${esc(c.name)}</p>`).join("") : `<p class="dim">還沒有。</p>`}
        </div>
        <div class="panel">
          ${group("end").map(btn).join("")}
        </div>
      </div>
    </div>`;
  }

  function reviewScreen(): string {
    const rv = review(CF, state!, run!);
    return `
    <div class="wrap">
      <h1>案件檔案　《${esc(rv.title)}》</h1>
      <p class="q">${rv.solved ? "你找到了她。" : "你沒有找到她。"}
        <span class="dim">耗時 ${Math.floor(rv.spent / 60)} 小時 ${rv.spent % 60} 分，收工於 ${rv.clock}</span></p>

      <h2>卦象紀錄</h2>
      <p class="mono">${esc(rv.gua.ben)}${rv.gua.bian ? ` 之 ${esc(rv.gua.bian)}` : ""}　${esc(rv.gua.palace)}
         用神落 ${rv.gua.keyPos ?? "-"} 區　代價 ${esc(rv.gua.access)}</p>

      <h2>已發現（${rv.found.length}）</h2>
      ${rv.found.length ? rv.found.map((c) => `<p class="itm">${esc(c.name)}<span class="dim">　${esc(c.text)}</span></p>`).join("") : `<p class="dim">什麼也沒查到。</p>`}

      ${rv.lost.length ? `<h2>錯失（${rv.lost.length}）</h2>${rv.lost.map((c) => `<p class="itm lost">${esc(c.name)}<span class="dim">　來遲了</span></p>`).join("")}` : ""}

      <h2>未發現（${rv.missed.length}）</h2>
      ${rv.missed.map(() => `<p class="itm dim">？？？</p>`).join("") || `<p class="dim">無。</p>`}

      <h2>同行紀錄</h2>
      <p class="itm">${rv.companion ? `${esc(rv.companion)}：${rv.companionFinds}／${rv.companionTotal}` : "獨自前往"}</p>

      <h2>案件真相</h2>
      <p class="${rv.truthShown ? "truth" : "truth hid"}">${rv.truthShown ? esc(CF.truth) : "未解。真相一直都在那裡，只是這一趟你沒走到。"}</p>

      <div class="row"><button class="big" data-act="again">再來一次</button></div>
    </div>`;
  }

  /* ═══ 渲染與事件 ═══ */

  function render() {
    app.innerHTML = run ? (run.ended ? reviewScreen() : playScreen()) : setupScreen();
    const log = document.getElementById("log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  app.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button");
    if (!t) return;

    if (t.dataset.pick !== undefined) { companion = t.dataset.pick || null; render(); return; }

    const act = t.dataset.act;
    if (act === "cast") { cast(); render(); return; }
    if (act === "enter") { run = startRun(CF, state!, companion); render(); return; }
    if (act === "togglegua") { showChart = !showChart; render(); return; }
    if (act === "again") { run = null; state = null; chart = null; showChart = false; render(); return; }

    if (t.dataset.opt !== undefined) {
      const o = curOpts[Number(t.dataset.opt)];
      if (!o) return;
      run = applyAction(CF, state!, run!, o.action);
      render();
    }
  });

    render();
  void chart;
}
