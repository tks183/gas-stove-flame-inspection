# 卡式炉试火实时检测系统（后端流处理架构）

## 架构

```text
Orbbec / USB / RTSP 摄像头
          │
          ▼
     FFmpeg 拉流
          │  MJPEG 帧
          ▼
      Node.js 后端
      ├─ 通道 A：纯 JS 颜色阈值 + 帧差
      ├─ 通道 B：YOLO ONNX 推理（DirectML GPU / CPU）
      ├─ 融合仲裁状态机
      ├─ Canvas 画框 + JPEG 编码
      └─ WebSocket 广播
          │
          ▼
    前端轻量展示
```

- 前端不加载 ONNX、不调用 `getUserMedia`，只负责显示 Base64 画面和指标。
- 后端使用 FFmpeg 读取 DirectShow 摄像头或 RTSP 流。
- 模型推理使用 `onnxruntime-node`，Windows 下优先使用 **DirectML GPU**；失败自动回退 CPU。
- WebGPU 无法直接在 Node.js 后端运行，本方案使用 Windows 原生的 DirectML 实现后端 GPU 加速。

## 模型

当前配置使用：

```text
models/exp-2.onnx
```

模型元数据：

```text
task = detect
classes = {0: 'Correct', 1: 'error'}
```

配置在 `config.json`：

```json
"classes": ["Correct", "error"],
"issueClasses": ["error"]
```

## 启动

双击：

```text
启动.bat
```

然后：

1. 选择摄像头 `Orbbec Femto Bolt RGB Camera`
2. 点击「启动视频流」
3. 点击「开始试火」
4. 需要检测熄火时点击「熄火检测」
5. 点击「复位」清除异常状态

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/health` | 健康状态、模型后端、摄像头状态 |
| `GET /api/cameras` | 列出 DirectShow 摄像头 |
| `POST /api/start` | 启动视频流 |
| `POST /api/stop` | 停止视频流 |
| `POST /api/command` | 下发 `start_test` / `extinguish_test` / `reset` |

WebSocket：`ws://localhost:3000/ws`

消息类型：

- `frame`：带检测框的实时画面
- `metrics`：状态、火焰占比、运动分数、YOLO 耗时等
- `log`：后端日志
- `phase`：状态机阶段变化

## 重新训练模型

替换 `models/exp-2.onnx`，或在 `config.json` 修改 `model.path`，并同步修改：

- `classes`
- `issueClasses`
- `confidenceThreshold`
- `inferEveryNFrames`

无需修改前后端代码。

## 开源许可证

本项目整体采用 **GNU Affero General Public License v3.0 (AGPL-3.0)**。

原因：`models/exp-3.onnx` 是由 Ultralytics YOLO 训练并导出的模型，Ultralytics 默认使用 AGPL-3.0。
如果只开源代码、不分发模型，可以在移除 `models/exp-3.onnx` 后改用 MIT 或 Apache-2.0。

详见 [LICENSE](./LICENSE) 和 [NOTICE.md](./NOTICE.md)。
