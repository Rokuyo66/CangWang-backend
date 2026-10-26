#!/usr/bin/env bash
# 在 WSL 裡執行：bash /mnt/d/cangwang/ai-studio/setup.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$HOME/.venvs/ai-studio"
cd "$DIR"

echo "== [1/5] Python 環境 =="
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv python3-pip >/dev/null
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r requirements.txt
echo "OK"

echo "== [2/5] 審稿模型（MoE 35B，約 24GB，會自動分到顯卡＋記憶體）=="
REV=""
for tag in qwen3.5:35b-a3b qwen3.5:35b; do
  if ollama pull "$tag"; then REV="$tag"; break; fi
done
[ -n "$REV" ] && echo "審稿模型：$REV" || echo "⚠️ 35B 下載失敗，暫用 qwen3.5:9b 審稿"

echo "== [3/5] config.json =="
[ -f config.json ] || cp config.example.json config.json
CUR_TOKEN=$("$VENV/bin/python" -c "import json;print(json.load(open('config.json'))['telegram_token'])")
if [ -z "$CUR_TOKEN" ]; then
  read -rp "貼上 BotFather 給的 bot token：" TOKEN
else
  TOKEN="$CUR_TOKEN"
fi
CUR_ID=$("$VENV/bin/python" -c "import json;print(json.load(open('config.json'))['admin_id'])")
read -rp "你的 TG 數字 ID [$CUR_ID]：" ADMIN
ADMIN="${ADMIN:-$CUR_ID}"
TOKEN="$TOKEN" ADMIN="$ADMIN" REV="$REV" "$VENV/bin/python" - <<'PY'
import json, os
c = json.load(open("config.json", encoding="utf-8"))
c["telegram_token"] = os.environ["TOKEN"].strip()
c["admin_id"] = int(os.environ["ADMIN"])
if os.environ["REV"]:
    c["reviewer_model"] = os.environ["REV"]
json.dump(c, open("config.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
echo "OK"

echo "== [4/5] 系統服務（WSL 開著就常駐，掛掉自動重啟）=="
sed -e "s|__USER__|$USER|g" -e "s|__DIR__|$DIR|g" -e "s|__VENV__|$VENV|g" \
  systemd/ai-studio.service | sudo tee /etc/systemd/system/ai-studio.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable ai-studio >/dev/null 2>&1

echo "== [5/5] 自檢 =="
"$VENV/bin/python" -m studio.selftest
sudo systemctl restart ai-studio
sleep 3
systemctl is-active ai-studio && echo "服務已啟動，手機 TG 應該會收到「夜間寫手台已上線」"
