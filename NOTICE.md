# 第三方组件与许可证说明

本项目使用或依赖以下组件：

- Ultralytics YOLO：训练 / 导出 `models/exp-3.onnx` 所用模型框架，默认采用 AGPL-3.0 许可证。
- ONNX Runtime Node (`onnxruntime-node`)：MIT License。
- Sharp：Apache-2.0 License。
- Express：MIT License。
- ws：MIT License。
- FFmpeg：按其构建版本对应的 LGPL/GPL 许可证使用；本仓库不包含 FFmpeg 二进制。

由于本仓库包含由 Ultralytics YOLO 训练导出的模型权重 `models/exp-3.onnx`，
为满足上游 AGPL-3.0 许可证要求，**本项目整体按 GNU Affero General Public License v3.0 (AGPL-3.0) 开源**。

如果你拥有 Ultralytics 商业许可证，或希望仅以 MIT/Apache-2.0 发布代码，
请从仓库中移除 `models/exp-3.onnx` 并将 `LICENSE` 替换为你选择的许可证。
