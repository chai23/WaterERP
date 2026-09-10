#!/bin/bash
# 雙擊強制重新建置並開啟超好企業進銷存系統 Mac 啟動器
# 之後只要改了啟動器功能，雙擊這個檔案即可
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

pause() {
  echo
  read -n 1 -s -r -p "按任意鍵關閉…"
}

if ! xcrun swiftc --version >/dev/null 2>&1; then
  echo "❌ 無法建置：尚未同意 Xcode 授權。"
  echo
  echo "請先打開「終端機」執行："
  echo "  sudo xcodebuild -license"
  echo
  echo "用方向鍵捲到最後，輸入 agree 後按 Enter。"
  echo "完成後再雙擊這個 rebuild.command。"
  pause
  exit 1
fi

echo "正在關閉舊的啟動器…"
pkill -x WaterErpMacLauncher >/dev/null 2>&1 || true
sleep 0.4

echo "正在重新建置啟動器（約需一兩分鐘）…"
echo
if bash "$DIR/build.sh"; then
  echo
  echo "✅ 新版啟動器已開啟。以後更新功能時，再雙擊 rebuild.command 即可。"
  exit 0
fi

echo
echo "❌ 建置失敗。請把上面的錯誤訊息截圖下來。"
pause
exit 1
