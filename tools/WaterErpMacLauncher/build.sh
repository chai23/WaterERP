#!/bin/bash
# 建置並啟動超好企業進銷存系統 Mac 原生啟動器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

DERIVED_DATA="$SCRIPT_DIR/build"
APP_PATH="$DERIVED_DATA/Build/Products/Release/WaterErpMacLauncher.app"

if ! xcrun swiftc --version >/dev/null 2>&1; then
  echo "❌ 無法建置：尚未同意 Xcode 授權。"
  echo "   請在終端機執行：sudo xcodebuild -license"
  echo "   同意後再重試 npm run mac:launcher"
  exit 1
fi

echo "🔨 正在建置超好企業進銷存系統 Mac 啟動器…"
LOG="$(mktemp -t watererp-mac-launcher-build)"
if ! xcodebuild \
  -project WaterErpMacLauncher.xcodeproj \
  -scheme WaterErpMacLauncher \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES \
  build >"$LOG" 2>&1; then
  echo "❌ 建置失敗，最後 40 行："
  tail -40 "$LOG"
  rm -f "$LOG"
  exit 1
fi
tail -20 "$LOG"
rm -f "$LOG"

if [ ! -d "$APP_PATH" ]; then
  echo "❌ 建置失敗，找不到 $APP_PATH"
  exit 1
fi

echo "✅ 建置完成：$APP_PATH"
open "$APP_PATH"
