"""團隊成員身分、狀態總覽、排程開關。"""
import time

from .common import ROOT, list_stage, load_config, load_state, read_json, save_state, write_json

OPS_DIR = ROOT / "ops"
INBOX = OPS_DIR / "inbox"
DONE = OPS_DIR / "done"
for d in (OPS_DIR, INBOX, DONE):
    d.mkdir(exist_ok=True)
JOBS_PATH = ROOT / "jobs.json"
CLAUDE_STATUS = OPS_DIR / "claude_status.json"

DEFAULT_JOBS = {
    "writing": {"name": "寫稿佇列", "desc": "佇列有題目就寫、審、重寫"},
    "idle_ideas": {"name": "閒置自動補信", "desc": "佇列空了就排下一封道緣信（三人輪流，每天最多 9 封）", "enabled": False},
    "claude_patrol": {"name": "Claude 巡檢", "desc": "定時讀日誌與失敗紀錄，能修就修並回報", "enabled": False},
    "nightly_ask": {"name": "每晚詢問排程", "desc": "每天晚上問你今晚要開哪些工作", "enabled": True},
}


def who(role: str) -> str:
    cfg = load_config()
    short = lambda m: m.replace("qwen3.5:", "Qwen ").upper().replace("QWEN", "Qwen")
    return {
        "duty": "🛎 值班",
        "writer": f"✍️ 寫手（{short(cfg['writer_model'])}）",
        "reviewer": f"🔎 審稿（{short(cfg['reviewer_model'])}）",
        "agent": f"🤖 本地助理（{short(cfg.get('agent_model', cfg['writer_model']))}）",
        "claude": "🧠 Claude",
        "mailbot": "📮 觀主管家",
    }.get(role, role)


def load_jobs() -> dict:
    saved = read_json(JOBS_PATH, {}) or {}
    jobs = {}
    for k, v in DEFAULT_JOBS.items():
        j = dict(v)
        j["enabled"] = saved.get(k, {}).get("enabled", v.get("enabled", True))
        jobs[k] = j
    jobs["writing"]["enabled"] = not load_state()["paused"]  # 寫稿開關＝暫停狀態
    return jobs


def set_job(key: str, on: bool):
    if key not in DEFAULT_JOBS:
        raise KeyError(key)
    if key == "writing":
        save_state(paused=not on)
        return
    saved = read_json(JOBS_PATH, {}) or {}
    saved[key] = {"enabled": bool(on)}
    write_json(JOBS_PATH, saved)


def job_on(key: str) -> bool:
    return load_jobs()[key]["enabled"]


def mmss(sec):
    sec = int(max(0, sec))
    if sec < 3600:
        return f"{sec // 60}:{sec % 60:02d}"
    return f"{sec // 3600}時{sec % 3600 // 60:02d}分"


def ago(ts):
    if not ts:
        return "—"
    d = time.time() - ts
    if d < 90:
        return "剛剛"
    if d < 3600:
        return f"{int(d // 60)} 分鐘前"
    if d < 86400:
        return f"{int(d // 3600)} 小時前"
    return f"{int(d // 86400)} 天前"


def roster(loaded_models=None, gpu=None, started_at=None, agent_busy=False, abtest=None) -> str:
    cfg, st = load_config(), load_state()
    cur = st.get("current") or {}
    step = cur.get("step", "")
    loaded = loaded_models or []
    now_t = time.time()

    def mem(model):
        return "（已載入）" if any(m.startswith(model) for m in loaded) else ""

    if cur and "審稿" in step:
        writer, reviewer = "閒置", f"工作中：#{cur['id']} {step}（{mmss(now_t - cur.get('step_at', now_t))}）"
    elif cur:
        writer, reviewer = f"工作中：#{cur['id']} {step}（{mmss(now_t - cur.get('step_at', now_t))}）", "閒置"
    else:
        writer = reviewer = "閒置"
    if not cur and st.get("blocked"):
        writer = f"等待：{st['blocked']}"

    jobs = load_jobs()
    cs = read_json(CLAUDE_STATUS, {}) or {}
    claude = ("啟用" if jobs["claude_patrol"]["enabled"] else "停用") + f"｜上次巡檢 {ago(cs.get('last_at'))}"
    if cs.get("summary"):
        claude += f"\n　　└ {cs['summary'][:80]}"

    q, p = len(list_stage("queue")), len(list_stage("pending"))
    lines = [
        "👥 團隊狀態",
        f"{who('duty')}　在線｜已上線 {mmss(now_t - started_at) if started_at else '—'}",
        f"{who('writer')}　{writer}{mem(cfg['writer_model'])}",
        f"{who('reviewer')}　{reviewer}{mem(cfg['reviewer_model'])}",
        f"{who('agent')}　{'回覆你中' if agent_busy else '閒置'}",
        f"{who('claude')}　{claude}",
        f"{who('mailbot')}　雲端運行（66-butler），狀態尚未串接",
        *([f"🧪 A/B 測試　{abtest}"] if abtest else []),
        "",
        f"題庫 {len(list_stage('ideas'))}｜佇列 {q}｜待審 {p}｜已通過 {len(list_stage('approved'))}",
    ]
    if gpu:
        lines.append(f"顯卡 使用率{gpu[0]}%｜{gpu[1]:.0f}°C｜上限{gpu[2]:.0f}W")
    on = [j["name"] for j in jobs.values() if j["enabled"]]
    lines.append("排程開啟：" + ("、".join(on) if on else "無"))
    return "\n".join(lines)
