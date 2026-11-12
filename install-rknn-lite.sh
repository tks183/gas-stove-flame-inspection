#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== RKNN Toolkit Lite2 installer for Orange Pi 5 / RK3588 ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Run: sudo apt install -y python3 python3-pip python3-opencv"
  exit 1
fi

sudo apt update
sudo apt install -y python3-pip python3-opencv python3-numpy curl ca-certificates

PY_TAG=$(python3 -c 'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}")')
echo "Python version: $(python3 --version)"
echo "Python wheel tag: ${PY_TAG}"

# RKNN Toolkit Lite2 2.5.0 wheels from Rockchip.
if [ "$PY_TAG" = "cp37" ]; then
  WHEEL_TAG="cp37-cp37m"
else
  WHEEL_TAG="${PY_TAG}-${PY_TAG}"
fi

WHEEL_NAME="rknn_toolkit_lite2-2.5.0-${WHEEL_TAG}-manylinux_2_17_aarch64.manylinux2014_aarch64.whl"
WHEEL_URL="https://raw.githubusercontent.com/airockchip/rknn-toolkit2/master/rknn-toolkit-lite2/packages/${WHEEL_NAME}"
WHEEL_PATH="/tmp/${WHEEL_NAME}"

echo "Downloading: ${WHEEL_URL}"
if ! curl -fL --retry 3 -o "$WHEEL_PATH" "$WHEEL_URL"; then
  echo ""
  echo "Download failed. Your Python version may not match an available wheel."
  echo "Check available wheels here:"
  echo "https://github.com/airockchip/rknn-toolkit2/tree/master/rknn-toolkit-lite2/packages"
  exit 1
fi

# Debian 12 may enforce PEP 668; use --break-system-packages when available.
if ! python3 -m pip install --no-deps --force-reinstall "$WHEEL_PATH"; then
  python3 -m pip install --break-system-packages --no-deps --force-reinstall "$WHEEL_PATH"
fi

echo ""
echo "Checking RKNN runtime library..."
if ! ldconfig -p 2>/dev/null | grep -q librknnrt; then
  echo "WARNING: librknnrt.so not found."
  echo "Install the RK3588 runtime library from rknpu2:"
  echo "  https://github.com/airockchip/rknn-toolkit2/tree/master/rknpu2/runtime/Linux/librknn_api/aarch64"
  echo "Copy librknnrt.so to /usr/lib/ and run: sudo ldconfig"
else
  echo "librknnrt.so found."
fi

if python3 -c "from rknnlite.api import RKNNLite; print('RKNNLite import OK')"; then
  echo ""
  echo "RKNN Toolkit Lite2 installed successfully."
else
  echo "RKNNLite import failed. Check Python version, wheel, and librknnrt.so."
  exit 1
fi
