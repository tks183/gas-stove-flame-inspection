import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Worker } from 'node:worker_threads';
import { MjpegFrameParser } from './src/frame-parser.js';
import { CvChannel } from './src/cv-channel.js';
import { FusionStateMachine } from './src/state-machine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const config = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/models', express.static(path.join(__dirname, 'models')));

const cvChannel = new CvChannel(config.cv);
const stateMachine = new FusionStateMachine(config);

let camera = null;
let cameraRunning = false;
let frameIndex = 0;
let processingFrame = false;
let latestYolo = { boxes: [], latency: 0, backend: '--' };
let yoloBusy = false;
let lastYoloStartedAt = 0;
let yoloRequestId = 0;
let detectorWorker = null;
let modelBackend = '--';
let latestMetrics = {
  phase: 'idle', phaseLabel: '待机', status: 'unknown', summary: '等待开始试火',
  reason: '', correctCount: 0, errorCount: 0, totalBoxes: 0,
  flameRatio: 0, motionScore: 0, brightRatio: 0, cvActive: false,
  yoloLatency: 0, backend: '--', fps: 0, timestamp: Date.now()
};
let lastFrameAt = 0;
let fps = 0;
let lastFpsAt = Date.now();
let fpsCounter = 0;
let currentSource = { ...config.camera };

function log(level, message) {
  const payload = { type: 'log', level, message, timestamp: Date.now() };
  console.log(`[${level}] ${message}`);
  broadcast(payload);
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(text);
  }
}

class CameraStream extends EventEmitter {
  constructor(source) {
    super();
    this.source = source;
    this.process = null;
    this.stderr = '';
    this.parser = new MjpegFrameParser((frame) => this.emit('frame', frame));
  }

  start() {
    if (this.process) return;
    const args = this.buildArgs();
    log('info', `启动 FFmpeg：${args.join(' ')}`);
    this.process = spawn(this.source.ffmpegPath || 'ffmpeg', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (chunk) => this.parser.push(chunk));
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderr = (this.stderr + text).slice(-4000);
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (/error|failed|invalid|device|busy/i.test(line)) log('warn', `FFmpeg: ${line.trim()}`);
      }
    });
    this.process.on('error', (err) => {
      log('error', `FFmpeg 启动失败: ${err.message}`);
      this.emit('error', err);
    });
    this.process.on('close', (code) => {
      log('warn', `FFmpeg 已退出，退出码 ${code}`);
      this.process = null;
      this.emit('close', code);
    });
  }

  buildArgs() {
    const fps = Number(this.source.fps || 30);
    const width = Number(this.source.width || 1280);
    const height = Number(this.source.height || 720);
    if (this.source.type === 'rtsp' && this.source.rtspUrl) {
      return [
        '-hide_banner', '-loglevel', 'warning',
        '-rtsp_transport', 'tcp',
        '-i', this.source.rtspUrl,
        '-f', 'mjpeg', '-q:v', '5', '-r', String(fps),
        'pipe:1'
      ];
    }
    return [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 'dshow',
      '-rtbufsize', '100M',
      '-framerate', String(fps),
      '-video_size', `${width}x${height}`,
      '-i', `video=${this.source.deviceName}`,
      '-f', 'mjpeg', '-q:v', '5', '-r', String(fps),
      'pipe:1'
    ];
  }

  stop() {
    this.parser.reset();
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }
}

async function startCamera(source = {}) {
  if (cameraRunning) return { ok: true, message: '摄像头已经在运行' };
  currentSource = { ...config.camera, ...source };
  if (currentSource.type === 'rtsp' && !currentSource.rtspUrl) {
    throw new Error('RTSP 地址为空');
  }
  if (currentSource.type !== 'rtsp' && !currentSource.deviceName) {
    throw new Error('请选择摄像头设备');
  }

  camera = new CameraStream(currentSource);
  camera.on('frame', onCameraFrame);
  camera.on('error', () => { cameraRunning = false; });
  camera.on('close', () => { cameraRunning = false; });
  camera.start();
  cameraRunning = true;
  cvChannel.reset();
  stateMachine.reset();
  latestYolo = { boxes: [], latency: 0, backend: modelBackend };
  log('info', `视频流已启动：${currentSource.type === 'rtsp' ? currentSource.rtspUrl : currentSource.deviceName}`);
  return { ok: true };
}

function stopCamera() {
  if (camera) {
    camera.stop();
    camera = null;
  }
  cameraRunning = false;
  cvChannel.reset();
  log('info', '视频流已停止');
}

function broadcastRawFrame(jpegBuffer) {
  if (config.sendRawFrames === false || wss.clients.size === 0) return;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jpegBuffer, { binary: true });
    }
  }
}

async function onCameraFrame(jpegBuffer) {
  // 原始高清画面直接转发给前端，保证 1080p/30fps 视频流不被 AI 处理阻塞。
  broadcastRawFrame(jpegBuffer);

  if (processingFrame || !cameraRunning) return;
  processingFrame = true;
  lastFrameAt = Date.now();
  const frameStarted = performance.now();

  try {
    const meta = await sharp(jpegBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) return;

    const { data, info } = await sharp(jpegBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const cv = cvChannel.analyze(data, info.width, info.height);

    frameIndex++;

    // 通道 B 降频异步推理：不阻塞每一帧的 CV 和画面推送。
    // 这样画面帧率由轻量 CV + 渲染决定，YOLO 结果则按 interval 刷新。
    const nowForYolo = Date.now();
    const yoloIntervalMs = Number(config.yoloIntervalMs ?? 300);
    if (!yoloBusy && detectorWorker && nowForYolo - lastYoloStartedAt >= yoloIntervalMs) {
      yoloBusy = true;
      lastYoloStartedAt = nowForYolo;
      detectorWorker.postMessage({ type: 'detect', id: ++yoloRequestId, buffer: jpegBuffer });
    }

    const metrics = stateMachine.update({
      yoloBoxes: latestYolo.boxes,
      cv,
      yoloLatency: latestYolo.latency,
      backend: latestYolo.backend
    });

    fpsCounter++;
    const now = Date.now();
    if (now - lastFpsAt >= 1000) {
      fps = Math.round((fpsCounter * 1000) / (now - lastFpsAt));
      fpsCounter = 0;
      lastFpsAt = now;
    }

    latestMetrics = {
      ...metrics,
      fps,
      timestamp: now,
      imageWidth: info.width,
      imageHeight: info.height,
      boxes: latestYolo.boxes.map(box => ({
        x: box.x, y: box.y, w: box.w, h: box.h,
        label: box.label, confidence: box.confidence, isIssue: box.isIssue
      })),
      processLatency: performance.now() - frameStarted
    };

    // 前端不需要展示传统 CV 的内部数值，避免误导。
    delete latestMetrics.flameRatio;
    delete latestMetrics.motionScore;
    delete latestMetrics.brightRatio;
    delete latestMetrics.cvActive;

    broadcast({ type: 'metrics', data: latestMetrics });
  } catch (err) {
    log('error', `帧处理失败: ${err.message}`);
  } finally {
    processingFrame = false;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    cameraRunning,
    modelBackend,
    source: currentSource,
    phase: latestMetrics.phase,
    status: latestMetrics.status,
    fps: latestMetrics.fps,
    lastFrameAgeMs: lastFrameAt ? Date.now() - lastFrameAt : null
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    classes: config.classes,
    issueClasses: config.issueClasses,
    confidenceThreshold: config.confidenceThreshold,
    camera: config.camera,
    fusion: config.fusion
  });
});

app.get('/api/cameras', async (_req, res) => {
  try {
    const devices = await listCameras();
    res.json({ ok: true, devices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  try {
    await startCamera(req.body || {});
    res.json({ ok: true, source: currentSource });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/stop', (_req, res) => {
  stopCamera();
  res.json({ ok: true });
});

app.post('/api/command', (req, res) => {
  handleCommand(req.body?.command || '');
  res.json({ ok: true, phase: stateMachine.phase });
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, cameraRunning, source: currentSource, metrics: latestMetrics });
});

function listCameras() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(currentSource.ffmpegPath || 'ffmpeg', [
      '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
    ], { windowsHide: true });
    let output = '';
    ffmpeg.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    ffmpeg.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', () => {
      const devices = [];
      const regex = /"([^"]+)"\s+\(video\)/g;
      let match;
      while ((match = regex.exec(output))) {
        if (!devices.includes(match[1])) devices.push(match[1]);
      }
      resolve(devices);
    });
  });
}

function handleCommand(command) {
  if (command === 'start_test') {
    stateMachine.startTest();
    log('info', '进入点火检测阶段');
  } else if (command === 'extinguish_test') {
    stateMachine.extinguishTest();
    log('info', '进入熄火检测阶段，请关闭气源');
  } else if (command === 'reset') {
    stateMachine.reset();
    log('info', '状态机已复位');
  }
  broadcast({ type: 'phase', data: { phase: stateMachine.phase, summary: stateMachine.lastSummary } });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', data: { config: { classes: config.classes }, metrics: latestMetrics, cameraRunning } }));
  ws.send(JSON.stringify({ type: 'metrics', data: latestMetrics }));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'command') handleCommand(msg.command);
    } catch {
      // ignore malformed message
    }
  });
});

function startDetectorWorker() {
  return new Promise((resolve, reject) => {
    detectorWorker = new Worker(new URL('./src/detector-worker.js', import.meta.url), {
      workerData: { config, rootDir: __dirname }
    });
    detectorWorker.on('message', (msg) => {
      if (msg.type === 'ready') {
        modelBackend = msg.backend;
        console.log(`[DetectorWorker] 后端: ${modelBackend}`);
        resolve();
      } else if (msg.type === 'result') {
        latestYolo = msg.result;
        yoloBusy = false;
      } else if (msg.type === 'infer-error') {
        yoloBusy = false;
        log('error', `YOLO 推理失败: ${msg.error}`);
      } else if (msg.type === 'fatal') {
        reject(new Error(msg.error));
      }
    });
    detectorWorker.on('error', (err) => {
      log('error', `Detector Worker 异常: ${err.message}`);
      reject(err);
    });
  });
}

await startDetectorWorker();
server.listen(Number(process.env.PORT || config.server?.port || 3000), () => {
  console.log(`\n卡式炉试火流处理服务已启动: http://localhost:${Number(process.env.PORT || config.server?.port || 3000)}\n`);
  if (config.camera?.autoStart) {
    startCamera(config.camera).catch(err => log('error', `自动启动摄像头失败: ${err.message}`));
  }
});

process.on('SIGINT', () => {
  stopCamera();
  detectorWorker?.terminate();
  process.exit(0);
});
