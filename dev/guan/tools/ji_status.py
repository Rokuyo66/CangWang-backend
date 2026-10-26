#!/usr/bin/env python3
"""GUAN-00 → JI-02：幾筆台唯讀狀態。只讀檔案，不 import 寫手台、不寫任何東西。

  python3 ji_status.py                # 總覽（給人看）
  python3 ji_status.py pending        # 等六六審的稿
  python3 ji_status.py night [小時]   # 最近 N 小時（預設 12）寫了什麼
  python3 ji_status.py stuck          # 卡住、等診斷的稿
  python3 ji_status.py --json …       # 同上，輸出 JSON（給觀樞台的模型讀）

寫手台位置：環境變數 JI_ROOT，預設 /mnt/d/cangwang/ai-studio
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("JI_ROOT", "/mnt/d/cangwang/ai-studio"))
TZ = timezone(timedelta(hours=8))
STAGE_NAME = {"queue": "排隊", "work": "寫作中", "claude": "等 Claude", "pending": "待六六審",
              "approved": "已通過", "rejected": "已捨棄"}


def _read(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _tasks(stage):
    out = []
    for p in sorted((ROOT / stage).glob("*.json")):
        t = _read(p)
        if t:
            out.append(t)
    return out


def _last(t):
    r = (t.get("rounds") or [{}])[-1]
    rv = r.get("review") or {}
    fin = (t.get("final_reviews") or [{}])[-1]
    return {"id": t.get("id"), "title": t.get("brief", ""), "kind": t.get("kind"), "rounds": len(t.get("rounds") or []),
            "score": rv.get("score"), "final_score": fin.get("score"), "hard": bool(rv.get("hard_fail")),
            "stuck": t.get("stuck") or "", "top_issues": [i.get("type") for i in (rv.get("issues") or [])[:3]]}


def summary():
    st = _read(ROOT / "state.json") or {}
    cur = st.get("current") or {}
    counts = {s: len(list((ROOT / s).glob("*.json"))) for s in STAGE_NAME}
    return {"paused": bool(st.get("paused")), "blocked": st.get("blocked"), "counts": counts,
            "current": {"id": cur.get("id"), "title": cur.get("brief"), "step": cur.get("step"),
                        "minutes": round((time.time() - cur.get("started", time.time())) / 60)} if cur else None}


def pending():
    return [_last(t) for t in _tasks("pending")]


def stuck():
    return [_last(t) for t in _tasks("claude")]


def night(hours=12):
    since = datetime.now(TZ) - timedelta(hours=hours)
    out = []
    for stage in ("work", "queue", "claude", "pending", "approved", "rejected"):
        for t in _tasks(stage):
            rs = []
            for r in t.get("rounds") or []:
                try:
                    at = datetime.fromisoformat(r.get("at", ""))
                except ValueError:
                    continue
                if (at if at.tzinfo else at.replace(tzinfo=TZ)) >= since:
                    rs.append(r)
            if rs:
                out.append({**_last(t), "stage": STAGE_NAME[stage], "rounds_tonight": len(rs),
                            "scores_tonight": [(r.get("review") or {}).get("score") for r in rs]})
    return out


def _fmt_item(x):
    s = f"・{x['title']}｜{x['score']}分"
    if x.get("final_score") is not None:
        s += f"（終審 {x['final_score']}）"
    if x.get("stage"):
        s += f"｜{x['stage']}"
    if x.get("stuck"):
        s += f"｜卡住：{x['stuck']}"
    if x.get("top_issues") and not x.get("stage") == "待六六審":
        s += "｜" + "、".join(x["top_issues"])
    return s + f"｜#{x['id']}"


def text(cmd, arg):
    if cmd == "pending":
        xs = pending()
        return "待你審：\n" + ("\n".join(map(_fmt_item, xs)) if xs else "（沒有）")
    if cmd == "stuck":
        xs = stuck()
        return "等 Claude 複審或診斷：\n" + ("\n".join(map(_fmt_item, xs)) if xs else "（沒有）")
    if cmd == "night":
        xs = night(arg)
        lines = [f"最近 {arg} 小時：{len(xs)} 份有動靜"]
        for x in xs:
            lines.append(_fmt_item(x) + f"｜寫了 {x['rounds_tonight']} 輪 {x['scores_tonight']}")
        return "\n".join(lines)
    s = summary()
    c = s["counts"]
    lines = ["幾筆台 " + ("⏸ 暫停中" if s["paused"] else ("⏳ " + s["blocked"] if s["blocked"] else "運作中")),
             f"排隊 {c['queue']}｜寫作中 {c['work']}｜待你審 {c['pending']}｜等 Claude {c["claude"]}｜已通過 {c['approved']}"]
    if s["current"]:
        cur = s["current"]
        lines.append(f"手上：{cur['title']}（{cur['step']}，已 {cur['minutes']} 分鐘）")
    return "\n".join(lines)


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if x != "--json"]
    cmd = a[0] if a else "summary"
    arg = int(a[1]) if len(a) > 1 and a[1].isdigit() else 12
    if not ROOT.exists():
        sys.exit(f"找不到幾筆台：{ROOT}（設 JI_ROOT）")
    if "--json" in sys.argv:
        data = {"summary": summary, "pending": pending, "stuck": stuck}.get(cmd)
        print(json.dumps(data() if data else night(arg), ensure_ascii=False, indent=1))
    else:
        print(text(cmd, arg))
