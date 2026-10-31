#!/usr/bin/env bash
# 一次性：允許寫手台不輸密碼重啟 ollama 與自己（只開這兩條，其他 sudo 照舊要密碼）
# 執行：bash /mnt/d/cangwang/ai-studio/grant-ops.sh
set -euo pipefail
SC=$(command -v systemctl)
RULE="$USER ALL=(root) NOPASSWD: $SC restart ollama, $SC restart ai-studio"
echo "$RULE" | sudo tee /etc/sudoers.d/ai-studio >/dev/null
sudo chmod 440 /etc/sudoers.d/ai-studio
sudo visudo -cf /etc/sudoers.d/ai-studio
sudo -n "$SC" restart ai-studio && echo "完成。寫手台已重啟，以後 Claude 可以透過工單重啟 Ollama。"
