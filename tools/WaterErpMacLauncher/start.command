#!/bin/bash
# 雙擊啟動超好企業進銷存系統 Mac 原生應用程式
# 若原始碼比可執行檔新，會自動重新建置後再開啟
# 若暫時無法建置（例如尚未同意 Xcode 授權），改開既有啟動器
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/Build/Products/Release/WaterErpMacLauncher.app"
BIN="$APP/Contents/MacOS/WaterErpMacLauncher"
SRC_DIR="$DIR/WaterErpMacLauncher"

xcode_ready() {
  xcrun swiftc --version >/dev/null 2>&1
}

open_existing_app() {
  if [ -x "$BIN" ]; then
    open "$APP"
    return 0
  fi
  return 1
}

needs_rebuild=0
if [ ! -x "$BIN" ]; then
  needs_rebuild=1
elif [ -d "$SRC_DIR" ]; then
  # 比對可執行檔時間，避免 .app 資料夾時間戳過舊卻誤判要重建
  if find "$SRC_DIR" "$DIR/WaterErpMacLauncher.xcodeproj" \
      \( -name "*.swift" -o -name "*.pbxproj" -o -name "*.plist" \) \
      -newer "$BIN" 2>/dev/null | grep -q .; then
    needs_rebuild=1
  fi
fi

if [ "$needs_rebuild" -eq 1 ] && xcode_ready; then
  echo "偵測到程式碼更新（或尚無建置），正在重新建置…"
  if bash "$DIR/build.sh"; then
    exit 0
  fi
  echo "⚠️ 建置失敗，改為開啟既有啟動器。"
fi

if open_existing_app; then
  exit 0
fi

echo "❌ 找不到啟動器，無法啟動。"
if ! xcode_ready; then
  echo "目前尚未同意 Xcode 授權，無法重新建置。"
  echo "請先在終端機執行：sudo xcodebuild -license"
  echo "同意後再雙擊 start.command 或執行 npm run mac:launcher"
fi
read -n 1 -s -r -p "按任意鍵關閉…"
exit 1
