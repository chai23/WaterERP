#!/bin/bash
# 雙擊啟動超好企業進銷存系統 Mac 原生應用程式
# 若原始碼比 .app 新，會自動重新建置後再開啟
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/Build/Products/Release/WaterErpMacLauncher.app"
SRC_DIR="$DIR/WaterErpMacLauncher"

needs_rebuild=0
if [ ! -d "$APP" ]; then
  needs_rebuild=1
elif [ -d "$SRC_DIR" ]; then
  # 任一 Swift／專案檔比已建置的 .app 還新 → 重建
  if find "$SRC_DIR" "$DIR/WaterErpMacLauncher.xcodeproj" \
      \( -name "*.swift" -o -name "*.pbxproj" -o -name "*.plist" \) \
      -newer "$APP" 2>/dev/null | grep -q .; then
    needs_rebuild=1
  fi
fi

if [ "$needs_rebuild" -eq 1 ]; then
  echo "偵測到程式碼更新（或尚無建置），正在重新建置…"
  bash "$DIR/build.sh"
else
  open "$APP"
fi
