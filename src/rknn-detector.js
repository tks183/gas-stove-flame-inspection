import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

/**
 * RKNN NPU 推理器。
 * Node.js 通过常驻 Python 子进程调用 rknn-toolkit-lite2，
 * 避免每一帧都重新加载 RKNN 模型。
 */
export class RknnDetector {
  constructor(config, rootDir) {
    this.config = config;
    this.rootDir = rootDir;
    this.process = null;
    this.readline = null;
    this.pending = null;
    this.nextId = 1;
    this.backend = 'RKNN NPU';
    this.lastLatency = 0;
  }

  async load() {
    const modelPath = path.isAbsolute(this.config.model.path)
      ? this.config.model.path
      : path.resolve(this.rootDir, this.config.model.path);
    const workerPath = path.resolve(
      this.rootDir,
      this.config.model.workerPath || 'src/rknn_worker.py'
    );
    const pythonPath = this.config.model.pythonPath || 'python3';
    const inputH = Number(this.config.model.inputSize?.[0] || 640);
    const inputW = Number(this.config.model.inputSize?.[1] || 640);
    const classes = JSON.stringify(this.config.classes || []);
    const conf = String(this.config.confidenceThreshold ?? 0.25);
    const nms = String(this.config.nmsThreshold ?? 0.45);

    this.process = spawn(pythonPath, [
      '-u', workerPath, modelPath,
      String(inputH), String(inputW),
      classes, conf, nms
    ], {
      cwd: this.rootDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stderr.on('data', chunk => {
      process.stderr.write(`[RKNN] ${chunk.toString('utf8')}`);
    });

    this.readline = readline.createInterface({ input: this.process.stdout });
    this.readline.on('line', line => this.onLine(line));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RKNN 模型加载超时')), 120000);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
      this.readyReject = (err) => { clearTimeout(timer); reject(err); };
    });

    console.log(`[RknnDetector] 模型加载完成: ${modelPath}`);
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[RKNN] ${line}\n`);
      return;
    }

    if (msg.type === 'ready') {
      this.backend = msg.backend || 'RKNN NPU';
      this.readyResolve?.();
      return;
    }
    if (msg.type === 'error' && !msg.id) {
      this.readyReject?.(new Error(msg.error || 'RKNN 初始化失败'));
      return;
    }
    if (msg.type === 'result' && this.pending && msg.id === this.pending.id) {
      const pending = this.pending;
      this.pending = null;
      this.lastLatency = Number(msg.latency || 0);
      const boxes = (msg.boxes || []).map(box => {
        const label = String(box.label);
        return {
          x: Number(box.x), y: Number(box.y),
          w: Number(box.w), h: Number(box.h),
          classIndex: Number(box.classIndex),
          label,
          confidence: Number(box.confidence),
          isIssue: this.isIssueLabel(label, Number(box.classIndex))
        };
      });
      pending.resolve({ boxes, latency: this.lastLatency, backend: this.backend });
      return;
    }
    if (msg.type === 'error' && this.pending && msg.id === this.pending.id) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error(msg.error || 'RKNN 推理失败'));
    }
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

  detect(jpegBuffer) {
    if (!this.process) return Promise.reject(new Error('RKNN 尚未加载'));
    if (this.pending) return Promise.reject(new Error('RKNN 正在处理上一帧'));

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const payload = JSON.stringify({
        id,
        image: jpegBuffer.toString('base64')
      }) + '\n';
      this.process.stdin.write(payload, err => {
        if (err) {
          this.pending = null;
          reject(err);
        }
      });
    });
  }

  stop() {
    this.readline?.close();
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }
}
