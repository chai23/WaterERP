#!/bin/bash
# 建置並啟動超好企業進銷存系統 Mac 原生啟動器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

DERIVED_DATA="$SCRIPT_DIR/build"
APP_PATH="$DERIVED_DATA/Build/Products/Release/WaterErpMacLauncher.app"

echo "🔨 正在建置超好企業進銷存系統 Mac 啟動器…"
xcodebuild \
  -project WaterErpMacLauncher.xcodeproj \
  -scheme WaterErpMacLauncher \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_ALLOWED=YES \
  build \
  2>&1 | tail -20

if [ ! -d "$APP_PATH" ]; then
  echo "❌ 建置失敗，找不到 $APP_PATH"
  exit 1
fi

echo "✅ 建置完成：$APP_PATH"
open "$APP_PATH"
