#!/usr/bin/env python3
"""GUAN-00 → ZHI-01：知錄台唯讀狀態。讀知錄台依 STATUS-CONTRACT.md 寫出的 status.json，不碰信箱。

  python3 zhi_status.py           # 給人看
  python3 zhi_status.py --json    # 原樣 JSON

位置：環境變數 ZHI_STATUS，預設 /mnt/d/cangwang/zhi/status.json（知錄台實際路徑定了再改）

觀樞台只讀這份摘要，不直接讀信：信件內容可能夾帶「請執行某某指令」的惡意文字，
讀信、判斷的事留在知錄台，觀樞台拿到的只有知錄台整理過的欄位。
"""
import json
import os
import sys
import time
from pathlib import Path

PATH = Path(os.environ.get("ZHI_STATUS", "/mnt/d/cangwang/zhi/status.json"))

if __name__ == "__main__":
    try:
        s = json.loads(PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"知錄台還沒寫出狀態檔：{PATH}（格式見 STATUS-CONTRACT.md）")
    if "--json" in sys.argv:
        print(json.dumps(s, ensure_ascii=False, indent=1))
        sys.exit()
    age = (time.time() - s.get("updated_at", 0)) / 3600
    lines = [f"知錄台｜{s.get('updated_at_text', '')}" + (f"（⚠️ {age:.0f} 小時沒更新）" if age > 6 else "")]
    if s.get("todo"):
        lines.append("要你處理：")
        lines += [f"・{x.get('title')}" + (f"（{x['due']} 前）" if x.get("due") else "") for x in s["todo"][:8]]
    if s.get("products"):
        lines.append("產品訊息：")
        lines += [f"・{x.get('title')}" for x in s["products"][:5]]
    if s.get("meetings"):
        lines.append("會議：")
        lines += [f"・{x.get('at')} {x.get('title')}" for x in s["meetings"][:5]]
    c = s.get("counts") or {}
    if c:
        lines.append("　".join(f"{k} {v}" for k, v in c.items()))
    print("\n".join(lines))
