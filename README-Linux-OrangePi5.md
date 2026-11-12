# Linux / Orange Pi 5 Debian 部署说明

本目录已经做跨平台适配：

- Windows：DirectShow + DirectML GPU
- Linux / Orange Pi 5：V4L2 摄像头 + ONNX Runtime CPU

## 1. 系统依赖

Orange Pi 5 官方 Debian：

```bash
sudo apt update
sudo apt install -y ffmpeg v4l-utils curl git build-essential ca-certificates
```

检查摄像头：

```bash
v4l2-ctl --list-devices
ls -l /dev/video*
```

## 2. 安装 Node.js 26.13.1

推荐使用 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 26.13.1
nvm use 26.13.1
node -v
```

应该显示：

```text
v26.13.1
```

## 3. 安装项目依赖

```bash
cd "项目目录"
npm install --no-audit --no-fund
```

或者直接运行：

```bash
./install-linux.sh
```

## 4. 配置摄像头

打开 `config.json`，找到：

```json
"camera": {
  "linux": {
    "type": "v4l2",
    "deviceName": "/dev/video0",
    "inputFormat": "mjpeg",
    "width": 1920,
    "height": 1080,
    "fps": 30
  }
}
```

根据实际摄像头修改：

- USB 摄像头通常是 `/dev/video0`
- 如果摄像头不支持 MJPEG，可把 `inputFormat` 改成 `yuyv422`
- 分辨率可改成 `1280` / `720` 提升 CPU 处理速度

如果使用 RTSP 网络摄像头，把 `camera.linux.type` 改成：

```json
"type": "rtsp",
"rtspUrl": "rtsp://用户名:密码@IP地址:554/stream"
```

## 5. 启动

```bash
chmod +x start.sh
./start.sh
```

然后浏览器打开：

```text
http://香橙派IP:3000
```

## 6. 性能说明

Orange Pi 5 没有 DirectML，ONNX Runtime 会使用 CPU（ARM64）。

建议：

- 视频保持 1080p30 原始流直传
- YOLO 检测间隔保持 `yoloIntervalMs: 300` 或更大
- 如果 CPU 负载过高，把摄像头分辨率改成 1280×720
- 后续如果要用 NPU，需要把 ONNX 模型转换成 RKNN 模型，并改用 RKNN Runtime

## 7. 防火墙

如果其他电脑打不开网页，检查端口：

```bash
sudo ufw allow 3000/tcp
```

或者查看香橙派 IP：

```bash
ip addr
```

## 8. RKNN NPU 推理

香橙派 5 使用 RK3588 NPU 时，需要：

1. 安装 `rknn-toolkit-lite2`（Rockchip 提供的 ARM64 Python wheel）
2. 安装 Python OpenCV 和 numpy：
   ```bash
   sudo apt install -y python3 python3-pip python3-opencv
   pip3 install numpy
   ```
3. 把导出的 RKNN 模型放到：
   ```text
   models/exp-4.rknn
   ```
4. 确认 `config.json`：
   ```json
   "model": {
     "path": "models/exp-4.onnx",
     "linux": {
       "runtime": "rknn",
       "path": "models/exp-4.rknn",
       "inputSize": [640, 640],
       "pythonPath": "python3",
       "workerPath": "src/rknn_worker.py"
     }
   }
   ```

Linux 启动后，Node.js 会启动常驻的 `src/rknn_worker.py`，由 Python 调用 RKNN Lite2，
通过 stdin/stdout 与 Node.js 交换帧和检测结果。

如果探针看到后端为：

```text
RKNN NPU (RK3588)
```

说明 NPU 推理已启用。

> 注意：模型输入预处理按 Ultralytics RKNN 标准使用 RGB、letterbox、640×640。
> 如果自己修改了导出参数，需要同步修改 `src/rknn_worker.py`。

## 9. 一键安装 RKNN Lite2

项目已附带：

```bash
chmod +x install-rknn-lite.sh
./install-rknn-lite.sh
```

脚本会自动：

- 安装 `python3-pip`、`python3-opencv`、`python3-numpy`
- 根据 Python 版本下载对应的 RKNN Toolkit Lite2 ARM64 wheel
- 安装并检查 `librknnrt.so`

如果下载失败，手动到 Rockchip 的发布页选择对应 Python 版本的 wheel：

```text
https://github.com/airockchip/rknn-toolkit2/tree/master/rknn-toolkit-lite2/packages
```

然后：

```bash
pip3 install --no-deps rknn_toolkit_lite2-2.5.0-cp310-cp310-manylinux_2_17_aarch64.manylinux2014_aarch64.whl
```
