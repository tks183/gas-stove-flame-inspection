#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Orange Pi 5 Debian install ==="

if command -v apt >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y ffmpeg v4l-utils curl git build-essential ca-certificates python3 python3-pip python3-opencv
fi

if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
  echo "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# shellcheck disable=SC1090
. "$HOME/.nvm/nvm.sh"
nvm install 26.13.1
nvm use 26.13.1

echo "Node.js: $(node -v)"
python3 -c "import cv2, numpy" || echo "WARNING: python3-opencv/numpy not ready"
python3 -c "from rknnlite.api import RKNNLite" || echo "WARNING: rknn-toolkit-lite2 not installed. Install the RK3588 RKNN Lite2 wheel before using the RKNN model."
echo "npm: $(npm -v)"
npm install --no-audit --no-fund

echo ""
echo "Install completed."
echo "Check camera: v4l2-ctl --list-devices"
echo "Check video nodes: ls -l /dev/video*"
echo "Then run: ./start.sh"
