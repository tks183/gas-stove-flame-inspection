import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import path from 'node:path';

export class Detector {
  constructor(config, rootDir) {
    this.config = config;
    this.rootDir = rootDir;
    this.session = null;
    this.inputName = '';
    this.outputName = '';
    this.inputWidth = Number(config.model?.inputSize?.[1]) || 640;
    this.inputHeight = Number(config.model?.inputSize?.[0]) || 640;
    this.backend = '--';
    this.lastLatency = 0;
  }

  async load() {
    const modelPath = path.isAbsolute(this.config.model.path)
      ? this.config.model.path
      : path.resolve(this.rootDir, this.config.model.path);

    const providers = [];
    const dmlDeviceId = Number(this.config.model?.deviceId ?? 0);
    // Windows 下 onnxruntime-node 自带 DirectML。
    // deviceId 用于指定 DirectX 适配器；0 通常是核显，1 通常是独显（以实际枚举顺序为准）。
    if (process.platform === 'win32') {
      providers.push({ name: 'dml', deviceId: dmlDeviceId });
    }
    providers.push('cpu');

    try {
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: providers,
        graphOptimizationLevel: 'all'
      });
      this.backend = process.platform === 'win32'
        ? `DirectML (GPU device ${dmlDeviceId})`
        : 'CPU';
    } catch (err) {
      if (process.platform === 'win32') {
        console.warn('[Detector] DirectML 初始化失败，回退 CPU:', err.message);
        this.session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all'
        });
        this.backend = 'CPU';
      } else {
        throw err;
      }
    }

    this.inputName = this.config.model?.inputName || this.session.inputNames[0];
    this.outputName = this.config.model?.outputName || this.session.outputNames[0];
    console.log(`[Detector] 模型加载完成: ${modelPath}`);
    console.log(`[Detector] 后端: ${this.backend}, 输入: ${this.inputName}, 输出: ${this.outputName}`);
  }

  async detect(jpegBuffer) {
    if (!this.session) throw new Error('模型尚未加载');

    const started = performance.now();
    const metadata = await sharp(jpegBuffer).metadata();
    const imageWidth = metadata.width;
    const imageHeight = metadata.height;
    if (!imageWidth || !imageHeight) throw new Error('无法读取画面尺寸');

    const targetW = this.inputWidth;
    const targetH = this.inputHeight;
    const scale = Math.min(targetW / imageWidth, targetH / imageHeight);
    const drawW = Math.max(1, Math.round(imageWidth * scale));
    const drawH = Math.max(1, Math.round(imageHeight * scale));
    const padLeft = Math.floor((targetW - drawW) / 2);
    const padTop = Math.floor((targetH - drawH) / 2);
    const right = targetW - drawW - padLeft;
    const bottom = targetH - drawH - padTop;

    let resized = await sharp(jpegBuffer)
      .rotate()
      .removeAlpha()
      .resize(drawW, drawH, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let raw = resized.data;
    let channels = resized.info.channels;
    if (right > 0 || bottom > 0 || padLeft > 0 || padTop > 0) {
      const extended = await sharp(raw, { raw: { width: drawW, height: drawH, channels } })
        .extend({
          top: padTop,
          bottom,
          left: padLeft,
          right,
          background: { r: 114, g: 114, b: 114 }
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      raw = extended.data;
      channels = extended.info.channels;
    }

    const plane = targetW * targetH;
    const floatData = new Float32Array(plane * 3);
    const normalize = this.config.model?.normalize || {};
    const pixelScale = Number(normalize.scale ?? (1 / 255));
    const mean = normalize.mean || [0, 0, 0];
    const std = normalize.std || [1, 1, 1];
    const bgr = String(this.config.model?.color || 'rgb').toLowerCase() === 'bgr';

    for (let i = 0; i < plane; i++) {
      const r = raw[i * channels];
      const g = raw[i * channels + 1];
      const b = raw[i * channels + 2];
      const c0 = bgr ? b : r;
      const c2 = bgr ? r : b;
      floatData[i] = (c0 * pixelScale - mean[0]) / (std[0] || 1);
      floatData[plane + i] = (g * pixelScale - mean[1]) / (std[1] || 1);
      floatData[plane * 2 + i] = (c2 * pixelScale - mean[2]) / (std[2] || 1);
    }

    const tensor = new ort.Tensor('float32', floatData, [1, 3, targetH, targetW]);
    const outputs = await this.session.run({ [this.inputName]: tensor });
    const output = outputs[this.outputName];
    if (!output) throw new Error('模型没有返回输出');

    const boxes = this.parseDetection(output, { scale, padLeft, padTop }, imageWidth, imageHeight);
    this.lastLatency = performance.now() - started;

    return {
      boxes,
      latency: this.lastLatency,
      backend: this.backend,
      imageWidth,
      imageHeight
    };
  }

  parseDetection(output, map, imageWidth, imageHeight) {
    const dims = output.dims || [];
    const data = output.data;
    if (dims.length < 2) throw new Error('检测输出维度不正确');

    let anchors;
    let attrs;
    let channelsFirst = false;

    if (dims.length === 3) {
      const a = Number(dims[1]);
      const b = Number(dims[2]);
      if (a <= 1024 && b > a) {
        attrs = a;
        anchors = b;
        channelsFirst = true;
      } else {
        anchors = a;
        attrs = b;
      }
    } else {
      anchors = dims[0];
      attrs = dims[1];
    }

    const classes = Array.isArray(this.config.classes) ? this.config.classes : [];
    let numClasses = classes.length;
    let hasObjectness = false;
    let end2end = false;

    if (numClasses && attrs === numClasses + 5) {
      hasObjectness = true;
    } else if (numClasses && attrs === numClasses + 4) {
      hasObjectness = false;
    } else if (attrs === 6 && anchors <= 1000 && numClasses !== 2) {
      // 端到端导出格式 [1, 300, 6]：x1,y1,x2,y2,score,class
      end2end = true;
    } else {
      const candidateNoObj = attrs - 4;
      const candidateObj = attrs - 5;
      if (candidateNoObj > 0 && candidateNoObj <= 500) {
        numClasses = candidateNoObj;
        hasObjectness = false;
      } else if (candidateObj > 0) {
        numClasses = candidateObj;
        hasObjectness = true;
      } else {
        throw new Error(`无法解析检测输出 attrs=${attrs}`);
      }
    }

    const threshold = Number(this.config.confidenceThreshold ?? 0.25);
    const boxes = [];

    for (let i = 0; i < anchors; i++) {
      const at = (offset) => channelsFirst ? data[offset * anchors + i] : data[i * attrs + offset];

      if (end2end) {
        const x1 = at(0);
        const y1 = at(1);
        const x2 = at(2);
        const y2 = at(3);
        const score = at(4);
        const classIndex = Math.round(at(5));
        if (score < threshold) continue;
        const box = this.mapBox(x1, y1, x2 - x1, y2 - y1, map, imageWidth, imageHeight);
        const label = classes[classIndex] || `class_${classIndex}`;
        boxes.push({ ...box, classIndex, label, confidence: score, isIssue: this.isIssueLabel(label, classIndex) });
        continue;
      }

      let objectness = 1;
      let classOffset = 4;
      if (hasObjectness) {
        objectness = at(4);
        classOffset = 5;
      }

      let bestScore = -Infinity;
      let bestClass = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = at(classOffset + c) * (hasObjectness ? objectness : 1);
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }
      if (bestScore < threshold || bestClass < 0) continue;

      const cx = at(0);
      const cy = at(1);
      const w = at(2);
      const h = at(3);
      const box = this.mapBox(cx - w / 2, cy - h / 2, w, h, map, imageWidth, imageHeight);
      const label = classes[bestClass] || `class_${bestClass}`;
      boxes.push({ ...box, classIndex: bestClass, label, confidence: bestScore, isIssue: this.isIssueLabel(label, bestClass) });
    }

    return this.nms(boxes, Number(this.config.nmsThreshold ?? 0.45))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 50);
  }

  mapBox(x, y, w, h, map, imageWidth, imageHeight) {
    let bx = (x - map.padLeft) / map.scale;
    let by = (y - map.padTop) / map.scale;
    let bw = w / map.scale;
    let bh = h / map.scale;
    bx = Math.max(0, Math.min(imageWidth, bx));
    by = Math.max(0, Math.min(imageHeight, by));
    bw = Math.max(1, Math.min(imageWidth - bx, bw));
    bh = Math.max(1, Math.min(imageHeight - by, bh));
    return { x: bx, y: by, w: bw, h: bh };
  }

  isIssueLabel(label, index) {
    const normalized = String(label).trim().toLowerCase().replace(/[\s_-]+/g, '');
    const issue = (this.config.issueClasses || []).map(v => String(v).toLowerCase().replace(/[\s_-]+/g, ''));
    const normal = (this.config.normalClasses || []).map(v => String(v).toLowerCase().replace(/[\s_-]+/g, ''));
    if (issue.includes(normalized)) return true;
    if (normal.includes(normalized)) return false;
    if ((this.config.issueClassIndexes || []).includes(index)) return true;
    if ((this.config.normalClassIndexes || []).includes(index)) return false;
    return /(error|abnormal|bad|ng|fail|异常)/i.test(normalized);
  }

  iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (inter <= 0) return 0;
    return inter / (a.w * a.h + b.w * b.h - inter);
  }

  nms(boxes, threshold) {
    const kept = [];
    for (const box of [...boxes].sort((a, b) => b.confidence - a.confidence)) {
      if (kept.every(k => k.classIndex !== box.classIndex || this.iou(k, box) < threshold)) {
        kept.push(box);
      }
    }
    return kept;
  }
}
