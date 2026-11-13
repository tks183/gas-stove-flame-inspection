# 卡式炉试火实时检测系统

基于 Node.js、FFmpeg、YOLO 和 WebSocket 的卡式炉试火实时检测系统。

支持：

- Windows：DirectShow 摄像头 + ONNX Runtime DirectML GPU
- Linux / 香橙派 5：V4L2 摄像头 + RKNN NPU
- 1080p30 原始视频帧实时推送
- YOLO 检测 + 传统 CV 辅助融合
- WebSocket 实时推送画面和指标
- 前端 Canvas 叠加检测框
- 点火 / 稳定 / 熄火 / 异常状态机

## 架构

```text
摄像头 (DirectShow / V4L2 / RTSP)
              │
              ▼
          FFmpeg 拉流
              │ MJPEG 帧
              ▼
        Node.js 后端
        ├─ 通道 A：颜色阈值 + 帧差
        ├─ 通道 B：YOLO 推理
        │    ├─ Windows：ONNX Runtime + DirectML
        │    └─ Linux：RKNN NPU (RK3588)
        ├─ 融合仲裁状态机
        └─ WebSocket 广播
              │
              ▼
        前端轻量展示
        ├─ 原始 1080p30 视频帧
        ├─ Canvas 检测框
        └─ 实时指标面板
```

- 前端不加载模型、不调用 `getUserMedia`。
- 视频帧通过 WebSocket 二进制消息直接转发，保证视频帧率。
- YOLO 推理运行在 Worker 线程中，Linux 下由独立 Python RKNN 进程执行，避免阻塞主线程。
- 检测框刷新频率约 3~4 次/秒，视频画面保持 30fps。

## 目录结构

```text
.
├─ server.js                 Node.js 主服务
├─ config.json               模型、摄像头、融合配置
├─ models/
│  ├─ exp-4.onnx              Windows ONNX 模型
│  └─ exp-4.rknn              香橙派 RKNN 模型
├─ src/
│  ├─ detector.js             ONNX Runtime 推理
│  ├─ detector-worker.js      推理 Worker 调度
│  ├─ rknn-detector.js        RKNN Python 进程通信
│  ├─ rknn_worker.py          RKNN Lite2 推理
│  ├─ cv-channel.js           颜色/帧差辅助通道
│  ├─ frame-parser.js         MJPEG 拆帧
│  └─ state-machine.js        融合与状态机
├─ public/                    HTML / CSS / JS 前端
├─ start.bat                  Windows 启动
├─ start.sh                   Linux 启动
├─ install-linux.sh           Linux 依赖安装
├─ install-rknn-lite.sh       RKNN Toolkit Lite2 安装
└─ git-backup.ps1             Git 备份脚本
```

## 模型与类别

当前模型：

```text
Windows: models/exp-4.onnx
Linux:   models/exp-4.rknn
```

类别：

```json
"classes": ["fire", "popular"],
"issueClasses": ["popular"],
"normalClasses": ["fire"]
```

主要参数：

```json
"confidenceThreshold": 0.5,
"nmsThreshold": 0.45,
"yoloIntervalMs": 300,
"cv": {
  "flameThreshold": 0.08,
  "motionThreshold": 2.5,
  "sampleStep": 4
}
```

## 环境要求

- Node.js `26.13.1`
- FFmpeg
- Windows：ONNX Runtime Node + DirectML
- Linux：Python 3 + RKNN Toolkit Lite2 2.5.0

## Windows 启动

双击：

```text
start.bat
```

或者：

```bash
npm install
npm start
```

浏览器打开：

```text
http://localhost:3000
```

## Linux / 香橙派 5 启动

```bash
chmod +x start.sh install-linux.sh install-rknn-lite.sh
./install-linux.sh
./install-rknn-lite.sh
./start.sh
```

摄像头默认：

```json
"linux": {
  "type": "v4l2",
  "deviceName": "/dev/video0",
  "inputFormat": "mjpeg",
  "width": 1920,
  "height": 1080,
  "fps": 30
}
```

浏览器打开：

```text
http://香橙派IP:3000
```

如果使用 RTSP 摄像头，把 `type` 改为 `rtsp` 并填写 `rtspUrl`。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康状态、模型后端、摄像头状态 |
| `GET /api/config` | 前端配置和默认摄像头参数 |
| `GET /api/cameras` | 列出摄像头 |
| `POST /api/start` | 启动视频流 |
| `POST /api/stop` | 停止视频流 |
| `POST /api/command` | 下发 `start_test` / `extinguish_test` / `reset` |
| `GET /api/status` | 当前状态和检测指标 |

WebSocket：`ws://localhost:3000/ws`

消息类型：

- `frame`：二进制 JPEG 视频帧
- `metrics`：状态、检测框、YOLO 耗时、处理帧率等
- `log`：后端日志
- `phase`：状态机阶段变化

## 重新训练模型

1. 替换 ONNX 和 RKNN 模型文件，例如：
   ```text
   models/exp-5.onnx
   models/exp-5.rknn
   ```
2. 修改 `config.json`：
   ```json
   "model": {
     "path": "models/exp-5.onnx",
     "linux": {
       "runtime": "rknn",
       "path": "models/exp-5.rknn"
     }
   }
   ```
3. 同步修改：
   - `classes`
   - `issueClasses`
   - `normalClasses`
   - `confidenceThreshold`
   - `inputSize`

RKNN 模型要求输入为 Ultralytics 标准导出格式：RGB、letterbox、640×640。

## Git 备份

使用：

```bash
git add -A
git commit -m "backup: 说明"
```

或 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\git-backup.ps1
```

## 开源许可证

本项目整体采用 **GNU Affero General Public License v3.0 (AGPL-3.0)**。

原因：`models/exp-4.onnx` 和 `models/exp-4.rknn` 是由 Ultralytics YOLO 训练并导出的模型，Ultralytics 默认使用 AGPL-3.0。
如果只开源代码、不分发模型，可以在移除模型文件后改用 MIT 或 Apache-2.0。

详见 [LICENSE](./LICENSE) 和 [NOTICE.md](./NOTICE.md)。
