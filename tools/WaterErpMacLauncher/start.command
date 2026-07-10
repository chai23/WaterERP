#!/bin/bash
# 雙擊啟動超好企業進銷存系統 Mac 原生應用程式
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/Build/Products/Release/WaterErpMacLauncher.app"

if [ ! -d "$APP" ]; then
  echo "首次使用，正在建置應用程式…"
  bash "$DIR/build.sh"
else
  open "$APP"
fi
