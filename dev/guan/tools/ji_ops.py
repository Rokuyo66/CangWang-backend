#!/usr/bin/env python3
"""GUAN-00 → JI-02 調度：只開放暫停／恢復寫稿。透過寫手台既有的工單匣（ops/inbox），
由幾筆台自己執行並在 TG 回報，觀樞台不直接動寫手台的任何檔案。

  python3 ji_ops.py pause  [備註]
  python3 ji_ops.py resume [備註]

寫手台工單匣另外還有 reload／刪模型等操作，那些**刻意不開放**給觀樞台：
它會讀網頁、聽自由輸入，被誤導的機會比 Claude 巡檢高。
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("JI_ROOT", "/mnt/d/cangwang/ai-studio"))
ALLOWED = {"pause": "暫停寫稿", "resume": "恢復寫稿"}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ALLOWED:
        sys.exit("只能用：" + "、".join(f"{k}（{v}）" for k, v in ALLOWED.items()))
    op, note = sys.argv[1], " ".join(sys.argv[2:])
    inbox = ROOT / "ops" / "inbox"
    if not inbox.is_dir():
        sys.exit(f"找不到幾筆台工單匣：{inbox}")
    name = time.strftime("%Y%m%d-%H%M%S") + f"-guan-{op}.json"
    tmp = inbox / (name + ".tmp")
    tmp.write_text(json.dumps({"from": "guan", "kind": "op", "op": op, "note": note}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, inbox / name)
    print(f"已送出工單：{ALLOWED[op]}，幾筆台 10 秒內執行並在 TG 回報")
