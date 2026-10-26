"""寫手台 ↔ 企劃工作臺 同步（給 Claude 巡檢用；不碰 Telegram、不碰模型）。

  python3 -m studio.sync pending            # 列出審過、還沒放進工作臺的稿（含轉好的工作臺文件）
  python3 -m studio.sync mark TID COL DOCID # 放進去之後記一筆
  python3 -m studio.sync reject TID 意見…   # 六六在工作臺駁回：帶意見送回本地端、排最前面重寫
  python3 -m studio.sync review             # 列出本地 ≥90、等 Claude 複審的稿（逐行版＋本地審稿）
  python3 -m studio.sync verdict TID 分數 意見…  # Claude 複審：≥95 交六六待審；否則帶意見排回重寫
  python3 -m studio.sync inbox              # 審過的稿推上收件匣、把工作臺的駁回拉回來（幾筆台每 10 分鐘自動跑）

規格：SYNC.md
"""
import json
import os
import sys
from datetime import datetime, timezone

from . import kinds
from .common import DIRS, find_task, load_config, log, read_json, write_json

COL = {"letter": "letters", "chapter": "chapters", "jh_outline": "jianghu"}
OUTLINE_KEYS = list(kinds.JhOutline.FIELD.values())
now = lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")


def doc_id(t):
    m = t["meta"]
    if t["kind"] == "letter":
        return f"{m['character_id']}_t{m['at']}"
    if t["kind"] == "chapter":
        return f"{m['character_id']}_c{m['chapter']}"
    return f"gua_{m['gua_no']:02d}"


def to_doc(t):
    m, d, r = t["meta"], t["rounds"][-1]["script"], t["rounds"][-1]
    ai = {"ai_task": t["id"], "ai_source": "ai-studio",
          "ai_meta": {"round": len(t["rounds"]), "score": r["review"].get("score"), "at": now()}}
    base = {"id": doc_id(t), "status": "review", "note": "", "updated_at": ai["ai_meta"]["at"], **ai}
    if t["kind"] == "letter":
        at = m["at"]
        return {**base, "character_id": m["character_id"], "at": at, "prev": kinds.Letter.PREV[at],
                "tier": kinds.Letter.TIER[at], "subject": d.get("subject", ""), "body": d.get("body", ""),
                "lingshi": d.get("lingshi", 0), "memory": d.get("memory", "")}
    if t["kind"] == "chapter":
        cid, n = m["character_id"], m["chapter"]
        return {**base, "character_id": cid, "chapter": n, "title": d.get("title", ""), "summary": d.get("summary", ""),
                "require_favor": kinds.FAVOR.get(n, 0), "require_event": f"{cid}_c{n-1}" if n > 1 else "",
                "require_cultivation": 0, "reward_lingshi": d.get("reward_lingshi", 0), "reward_avatar": "",
                "reward_outfit": "", "reward_theme": "", "reward_other": "", "reward_memory": d.get("reward_memory", ""),
                "char_title": {"label": d.get("reward_title", ""), "voice_hint": "", "desc": ""},
                "player_title": {"id": "", "label": "", "call_as": "", "voice_hint": ""},
                "scenes": d.get("scenes") or [{"bg": "guanmen", "text": ""}]}
    g = kinds.gua_data()[m["gua_no"] - 1]
    o = d.get("outline") or {}
    return {**base, "status": "draft", "gua_no": g["gua_no"], "gua": g["gua"], "title": d.get("title", ""),
            "tone": d.get("tone", "small"), "outline": {k: o.get(k, "") for k in OUTLINE_KEYS},
            "identity": {"mode": "disciple", "label": "", "reason": "", **(d.get("identity") or {})},
            "npcs": d.get("npcs") or [], "opening": {"bg": "", "text": ""},
            "nodes": [{"title": "", "scenes": [{"text": ""}], "change": {"scenes": []}} for _ in range(6)],
            "endings": [{"id": "e_base", "title": "空手而歸", "need": {}, "rare": False, "text": "", "insight": "",
                         "npc_fate": "", "reward_lingshi": 0, "player_title": {"label": "", "desc": "", "call_as": ""},
                         "hook": {"who": "", "ask": "", "memory": ""}}],
            "achievement": {"name": "", "desc": "", "ending": ""}, "achievements": []}


def pending():
    out = []
    for p in sorted(DIRS["approved"].glob("*.json")):
        t = read_json(p) or {}
        if t.get("kind") not in COL or not t.get("rounds"):
            continue
        s = t.get("sync") or {}
        if s.get("round") == len(t["rounds"]):
            continue
        out.append({"task": t["id"], "col": COL[t["kind"]], "doc_id": doc_id(t),
                    "rewrite_of_reject": bool(s.get("rejected")), "doc": to_doc(t)})
    return out


def mark(tid, col, did):
    st, p = find_task(tid)
    t = read_json(p)
    t["sync"] = {**(t.get("sync") or {}), "col": col, "doc_id": did, "round": len(t["rounds"]), "at": now(), "rejected": ""}
    write_json(p, t)
    return f"#{tid} → {col}/{did}（第 {len(t['rounds'])} 輪）"


def reject(tid, text):
    st, p = find_task(tid)
    if not p:
        return f"找不到 #{tid}"
    t = read_json(p)
    t["human_feedback"] = [f"【工作臺駁回】{text}"]
    t["cap_base"] = len(t.get("rounds") or [])
    t["priority"] = True
    t.pop("needs_human", None)
    t["status"] = "queue"
    t["sync"] = {**(t.get("sync") or {}), "rejected": text, "rejected_at": now()}
    dst = DIRS["queue"] / f"{tid}.json"
    write_json(p, t)
    if p != dst:
        os.replace(p, dst)
    return f"#{tid}（原在 {st}）帶意見排到佇列最前面"


def review_list():
    out = []
    for p in sorted(DIRS["claude"].glob("*.json")):
        t = read_json(p) or {}
        k = kinds.kind_of(t)
        if not k or not t.get("rounds"):
            continue
        last = t["rounds"][-1]
        out.append({"task": t["id"], "label": k.label(t), "local_score": last["review"].get("score"),
                    "rounds": len(t["rounds"]), "stuck": t.get("stuck") or "", "local_issues": last["review"].get("issues", []),
                    "text": k.numbered(last["script"], t)})
    return out


def verdict(tid, score, notes):
    st, p = find_task(tid)
    if st != "claude":
        return f"#{tid} 不在複審區（在 {st}）"
    t = read_json(p)
    score = int(score)
    t.setdefault("claude_reviews", []).append({"round": len(t["rounds"]), "score": score, "notes": notes, "at": now()})
    if score >= 95:
        t["needs_human"] = False
        to = "pending"
    else:
        t["human_feedback"] = [f"【Claude 複審 {score} 分】{notes}"]
        t["priority"] = True
        t["cap_base"] = len(t["rounds"])
        t.pop("stuck", None)
        to = "queue"
    t["status"] = to
    dst = DIRS[to] / f"{tid}.json"
    write_json(p, t)
    os.replace(p, dst)
    return f"#{tid} Claude {score} 分 → {'交六六待審' if to == 'pending' else '排回重寫'}"


# ---------- 收件匣（Supabase studio-inbox，見 supabase/migrations/0108）----------
# 工作臺是 claude.ai Artifact，本機寫不進去。以前靠 Claude 手動搬，現在推上收件匣，
# 工作臺打開時自己收（規則照 SYNC.md：她改過的不覆蓋、江湖大綱只補空欄，這段在工作臺那頭做）。
def _inbox(method, action, payload=None):
    import httpx
    cfg = load_config()
    url, key = cfg.get("studio_inbox_url"), cfg.get("studio_key")
    if not url or not key:
        return None
    r = httpx.request(method, f"{url.rstrip('/')}/{action}", json=payload,
                      headers={"x-studio-key": key}, timeout=30)
    r.raise_for_status()
    return r.json()


def inbox_push():
    """approved 裡還沒推過的稿推上去；推成功才 mark（這樣 pending() 下次不會再列）。"""
    items = pending()
    if not items:
        return []
    ts = {x["task"]: read_json(find_task(x["task"])[1]) for x in items}
    payload = [{"task": x["task"], "round": len(ts[x["task"]]["rounds"]), "col": x["col"],
                "doc_id": x["doc_id"], "doc": x["doc"]} for x in items]
    if _inbox("POST", "push", {"items": payload}) is None:
        return []
    return [mark(x["task"], x["col"], x["doc_id"]) for x in items]


def inbox_rejects():
    """工作臺駁回 → 帶意見排回佇列最前面；排好才 ack，當機沒排到的下次還拉得到。"""
    r = _inbox("GET", "rejects")
    out, done = [], []
    for x in (r or {}).get("items", []):
        msg = reject(x["task_id"], x["text"])
        out.append(msg)
        if not msg.startswith("找不到"):
            done.append(x["id"])
        else:
            log.warning("工作臺駁回對不到任務：%s", x["task_id"])
            done.append(x["id"])   # 對不到的也 ack，免得每 10 分鐘撞一次；log 裡查得到
    if done:
        _inbox("POST", "rejects_ack", {"ids": done})
    return out


def inbox_sync():
    return {"pushed": inbox_push(), "rejected": inbox_rejects()}


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["pending"]:
        print(json.dumps(pending(), ensure_ascii=False, indent=1))
    elif a[:1] == ["mark"] and len(a) == 4:
        print(mark(*a[1:]))
    elif a[:1] == ["reject"] and len(a) >= 3:
        print(reject(a[1], " ".join(a[2:])))
    elif a[:1] == ["review"]:
        print(json.dumps(review_list(), ensure_ascii=False, indent=1))
    elif a[:1] == ["verdict"] and len(a) >= 4:
        print(verdict(a[1], a[2], " ".join(a[3:])))
    elif a[:1] == ["inbox"]:
        print(json.dumps(inbox_sync(), ensure_ascii=False, indent=1))
    else:
        print(__doc__)
