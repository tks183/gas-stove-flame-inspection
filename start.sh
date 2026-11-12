#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 如果使用 nvm，则优先切换到项目要求的 Node.js 26.13.1
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh"
  nvm use 26.13.1 >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 26.13.1 first (nvm recommended)."
  exit 1
fi

echo "Using Node.js $(node -v)"
echo "Using npm $(npm -v)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found. Install it with: sudo apt install -y ffmpeg"
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi

echo "Starting gas stove ignition inspection system..."
echo "Open http://<orange-pi-ip>:3000 from another computer, or http://localhost:3000 locally."
echo "Press Ctrl+C to stop."

# 有桌面环境时，等服务就绪后自动打开浏览器
(
  for _ in $(seq 1 120); do
    if command -v curl >/dev/null 2>&1 && curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      if [ -n "${DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
        xdg-open http://localhost:3000 >/dev/null 2>&1 || true
      fi
      break
    fi
    sleep 0.5
  done
) &

exec npm start
