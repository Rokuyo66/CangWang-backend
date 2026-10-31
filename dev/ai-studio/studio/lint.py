"""程式檢查：能用規則查的就不交給模型。回傳與審稿同格式的 issues（多一個 by="程式"）。"""
import re

MAIN = {"大師兄": "daoshi_m", "師妹": "daoshi_f", "觀喵": "lingshou"}
ID2NAME = {v: k for k, v in MAIN.items()}
ALIASES = {"觀貓": "觀喵", "貓": "觀喵", "喵師傅": "觀喵", "師兄": "大師兄"}
# 說話者 → 台詞裡不該出現的稱呼（對使用者或對他人）
WRONG_ADDRESS = {
    "大師兄": ["施主", "鏟屎的", "兩腳獸", "觀喵", "貓兒", "這貓"],
    "師妹": ["護道人", "鏟屎的", "兩腳獸"],
    "觀喵": ["施主", "護道人"],
}
SIMPLIFIED = set("们这说时会对过还没发现开关问题东车门马话钱银书")


def _issue(t, where, detail, fix, hard=False):
    return {"type": t, "where": where, "detail": detail, "fix": fix, "by": "程式", "hard": hard}


def norm_speaker(s):
    s = (s or "").strip()
    s = ID2NAME.get(s, s)
    return ALIASES.get(s, s)


def check(script: dict):
    out = []
    scenes = script.get("scenes") or []
    on_duty = ID2NAME.get(script.get("on_duty"), script.get("on_duty"))
    if not scenes:
        return [_issue("格式", "全篇", "沒有任何場景", "至少寫 1 個場景", True)]
    if len(scenes) > 3:
        out.append(_issue("格式", "全篇", f"{len(scenes)} 個場景，超過上限 3", "合併成 1–3 場", True))
    n, text_lines, by_speaker = 0, 0, {}
    for si, sc in enumerate(scenes, 1):
        lines = sc.get("lines") or []
        if not lines:
            out.append(_issue("格式", f"場景{si}", "這一場沒有任何台詞或動作", "補內容或刪掉這場", True))
        if not (sc.get("setting") or "").strip():
            out.append(_issue("格式", f"場景{si}", "場景描述是空的", "補一句場景"))
        for ln in lines:
            n += 1
            raw = (ln.get("speaker") or "").strip()
            spk = norm_speaker(raw)
            act, txt = (ln.get("action") or "").strip(), (ln.get("text") or "").strip()
            if raw in ID2NAME:
                out.append(_issue("格式", f"L{n}", f"說話者寫成代號「{raw}」", f"改成「{ID2NAME[raw]}」", True))
            if not raw:
                out.append(_issue("格式", f"L{n}", "說話者是空的", "補上說話者", True))
            if not act and not txt:
                out.append(_issue("格式", f"L{n}", "動作和台詞都是空的", "補內容或刪掉這行", True))
            if txt:
                text_lines += 1
                by_speaker[spk] = by_speaker.get(spk, 0) + 1
                for w in WRONG_ADDRESS.get(spk, []):
                    if w in txt:
                        out.append(_issue("稱呼錯誤", f"L{n}", f"{spk}的台詞出現「{w}」",
                                          "對照稱呼表改正", True))
                if spk == "大師兄" and re.search(r"不是.{1,12}而是", txt):
                    out.append(_issue("禁用模式", f"L{n}", "大師兄用了「不是A而是B」句式", "改成直接陳述"))
            bad = SIMPLIFIED & set(act + txt)
            if bad:
                out.append(_issue("格式", f"L{n}", f"疑似簡體字：{''.join(sorted(bad))}", "改成繁體"))
    if text_lines < 4:
        out.append(_issue("格式", "全篇", f"有台詞的只有 {text_lines} 行", "對白至少 6 行", True))
    mains = {k: v for k, v in by_speaker.items() if k in MAIN}
    if len(mains) == 3:
        out.append(_issue("設定衝突", "全篇", "三位主角都有台詞，變成群聊", "只留當值角色為主，其他人最多插一兩句", True))
    for k, v in mains.items():
        if on_duty and k != on_duty and v > 2:
            out.append(_issue("設定衝突", "全篇", f"非當值的{k}講了 {v} 句", f"{k}最多插 2 句，其餘交給{on_duty}"))
    if on_duty and mains and mains.get(on_duty, 0) < max(mains.values()):
        out.append(_issue("設定衝突", "全篇", f"當值角色{on_duty}的台詞不是最多", "讓當值角色主導"))
    if not script.get("choices"):
        out.append(_issue("格式", "選項", "沒有選項", "給 2–3 個選項"))
    return out


def has_hard(issues):
    return any(i.get("hard") for i in issues)


def address_lines(issues):
    """程式確認過的稱呼錯誤所在行。"""
    return {i["where"] for i in issues if i["type"] == "稱呼錯誤"}
