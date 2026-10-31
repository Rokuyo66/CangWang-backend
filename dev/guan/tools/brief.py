#!/usr/bin/env python3
"""GUAN-00 每日總簡報：幾筆台＋知錄台，一則訊息看完。觀樞台每天早上跑一次推給六六。

  python3 brief.py
"""
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(*args):
    r = subprocess.run([sys.executable, str(HERE / args[0]), *args[1:]], capture_output=True, text=True, timeout=60)
    return (r.stdout or r.stderr).strip()


if __name__ == "__main__":
    now = datetime.now(timezone(timedelta(hours=8)))
    print(f"🏛 觀樞台｜{now:%m/%d %a} 早安簡報\n")
    print("✍️ " + run("ji_status.py"))
    print(run("ji_status.py", "pending"))
    stuck = run("ji_status.py", "stuck")
    if "（沒有）" not in stuck:
        print(stuck)
    print("\n📮 " + run("zhi_status.py"))
