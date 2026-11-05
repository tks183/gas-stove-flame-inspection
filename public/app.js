const backendPill = document.getElementById('backendPill');
const backendText = document.getElementById('backendText');
const cameraPill = document.getElementById('cameraPill');
const cameraText = document.getElementById('cameraText');
const wsPill = document.getElementById('wsPill');
const wsText = document.getElementById('wsText');
const streamImage = document.getElementById('streamImage');
const overlayCanvas = document.getElementById('overlayCanvas');
const stagePlaceholder = document.getElementById('stagePlaceholder');
const liveBadge = document.getElementById('liveBadge');
const fpsBadge = document.getElementById('fpsBadge');
const cameraSelect = document.getElementById('cameraSelect');
const refreshBtn = document.getElementById('refreshBtn');
const startStreamBtn = document.getElementById('startStreamBtn');
const stopStreamBtn = document.getElementById('stopStreamBtn');
const startTestBtn = document.getElementById('startTestBtn');
const extinguishBtn = document.getElementById('extinguishBtn');
const resetBtn = document.getElementById('resetBtn');
const errorText = document.getElementById('errorText');
const phaseTag = document.getElementById('phaseTag');
const statusCard = document.getElementById('statusCard');
const statusIcon = document.getElementById('statusIcon');
const statusTitle = document.getElementById('statusTitle');
const statusDesc = document.getElementById('statusDesc');
const correctCount = document.getElementById('correctCount');
const errorCount = document.getElementById('errorCount');
const yoloLatency = document.getElementById('yoloLatency');
const fpsValue = document.getElementById('fpsValue');
const videoFpsValue = document.getElementById('videoFpsValue');
const backendValue = document.getElementById('backendValue');
const reasonText = document.getElementById('reasonText');
const logBox = document.getElementById('logBox');

let ws = null;
let reconnectTimer = null;
let lastFrameUrl = '';
let cameraRunning = false;
let latestBoxes = [];
let latestImageWidth = 0;
let latestImageHeight = 0;
let displayFpsCounter = 0;
let displayFps = 0;
let displayFpsStartedAt = performance.now();

function showError(message) {
  errorText.textContent = message;
  errorText.classList.remove('hidden');
}
function clearError() {
  errorText.textContent = '';
  errorText.classList.add('hidden');
}

function addLog(level, message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line ${level || 'info'}`;
  line.textContent = `[${time}] ${message}`;
  logBox.appendChild(line);
  while (logBox.children.length > 120) logBox.removeChild(logBox.firstChild);
  logBox.scrollTop = logBox.scrollHeight;
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function loadHealth() {
  try {
    const data = await fetchJSON('/api/health');
    backendPill.className = 'health-pill ok';
    backendText.textContent = `模型: ${data.modelBackend || '--'}`;
    setCameraState(Boolean(data.cameraRunning));
  } catch (err) {
    backendPill.className = 'health-pill error';
    backendText.textContent = '模型未就绪';
    showError(err.message);
  }
}

async function loadCameras() {
  cameraSelect.innerHTML = '<option value="">正在读取摄像头…</option>';
  try {
    const data = await fetchJSON('/api/cameras');
    const devices = data.devices || [];
    if (!devices.length) {
      cameraSelect.innerHTML = '<option value="">未发现摄像头</option>';
      addLog('warn', 'FFmpeg 未发现 DirectShow 摄像头设备');
      return;
    }
    cameraSelect.innerHTML = devices.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    const preferred = devices.find(d => /Orbbec|RGB/i.test(d)) || devices[0];
    cameraSelect.value = preferred;
    addLog('info', `发现摄像头: ${devices.join(' / ')}`);
  } catch (err) {
    cameraSelect.innerHTML = '<option value="">摄像头读取失败</option>';
    showError(`读取摄像头失败: ${err.message}`);
  }
}

function setCameraState(running) {
  cameraRunning = running;
  if (running) {
    latestBoxes = [];
    latestImageWidth = 0;
    latestImageHeight = 0;
    drawOverlay();
    cameraPill.className = 'health-pill ok';
    cameraText.textContent = '视频流运行中';
    liveBadge.classList.remove('hidden');
    startStreamBtn.disabled = true;
    stopStreamBtn.disabled = false;
  } else {
    cameraPill.className = 'health-pill';
    cameraText.textContent = '视频流未启动';
    liveBadge.classList.add('hidden');
    startStreamBtn.disabled = false;
    stopStreamBtn.disabled = true;
    streamImage.classList.remove('active');
    streamImage.removeAttribute('src');
    stagePlaceholder.classList.remove('hidden');
    // 停止视频流时立即清空检测框，避免占位画面上残留旧框。
    latestBoxes = [];
    latestImageWidth = 0;
    latestImageHeight = 0;
    drawOverlay();
  }
}

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.addEventListener('open', () => {
    wsPill.className = 'health-pill ok';
    wsText.textContent = 'WebSocket 已连接';
    addLog('info', 'WebSocket 连接成功');
  });

  ws.addEventListener('message', (event) => {
    // 二进制消息 = 1080p 原始视频帧，直接显示，不经过 AI 阻塞。
    if (event.data instanceof Blob) {
      if (!cameraRunning) return;
      const newUrl = URL.createObjectURL(event.data);
      const oldUrl = lastFrameUrl;
      lastFrameUrl = newUrl;
      streamImage.src = newUrl;
      streamImage.classList.add('active');
      stagePlaceholder.classList.add('hidden');
      if (oldUrl) setTimeout(() => URL.revokeObjectURL(oldUrl), 1200);
      countDisplayFps();
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'metrics') {
        renderMetrics(msg.data);
      } else if (msg.type === 'log') {
        addLog(msg.level, msg.message);
      } else if (msg.type === 'hello') {
        if (msg.data?.cameraRunning) setCameraState(true);
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.addEventListener('close', () => {
    wsPill.className = 'health-pill error';
    wsText.textContent = 'WebSocket 已断开';
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  });

  ws.addEventListener('error', () => {
    wsPill.className = 'health-pill error';
    wsText.textContent = 'WebSocket 连接失败';
  });
}

function sendCommand(command) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showError('WebSocket 尚未连接，无法下发指令');
    return;
  }
  ws.send(JSON.stringify({ type: 'command', command }));
  clearError();
}

function renderMetrics(data) {
  if (!data) return;
  if (!cameraRunning) {
    latestBoxes = [];
    drawOverlay();
    return;
  }
  const status = data.status || 'unknown';
  statusCard.className = `status-card ${status === 'issue' ? 'issue' : status === 'normal' ? 'normal' : 'unknown'}`;
  statusIcon.textContent = status === 'issue' ? '!' : status === 'normal' ? '✓' : '?';
  statusTitle.textContent = data.summary || '分析中';
  statusDesc.textContent = data.reason || '实时刷新中';
  phaseTag.textContent = data.phaseLabel || '--';

  correctCount.textContent = String(data.correctCount || 0);
  errorCount.textContent = String(data.errorCount || 0);
  yoloLatency.textContent = `${(data.yoloLatency || 0).toFixed(0)} ms`;
  fpsValue.textContent = `${data.fps || 0} FPS`;
  backendValue.textContent = data.backend || '--';
  reasonText.textContent = data.reason || '—';

  latestBoxes = data.boxes || [];
  latestImageWidth = data.imageWidth || 0;
  latestImageHeight = data.imageHeight || 0;
  drawOverlay();
}

function countDisplayFps() {
  displayFpsCounter++;
  const now = performance.now();
  if (now - displayFpsStartedAt >= 1000) {
    displayFps = Math.round((displayFpsCounter * 1000) / (now - displayFpsStartedAt));
    displayFpsCounter = 0;
    displayFpsStartedAt = now;
    videoFpsValue.textContent = `${displayFps} FPS`;
    fpsBadge.textContent = `${displayFps} FPS`;
  }
}

function drawOverlay() {
  const rect = document.querySelector('.stage-wrap').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
    overlayCanvas.width = width;
    overlayCanvas.height = height;
  }
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!cameraRunning || !latestBoxes.length || !latestImageWidth || !latestImageHeight) return;

  const scaleX = overlayCanvas.width / latestImageWidth;
  const scaleY = overlayCanvas.height / latestImageHeight;
  const lineWidth = Math.max(2, Math.round(overlayCanvas.width / 600));
  const fontSize = Math.max(13, Math.round(overlayCanvas.width / 65));
  ctx.font = `700 ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';

  for (const box of latestBoxes) {
    const color = box.isIssue ? '#ff4d5e' : '#24d18b';
    const x = box.x * scaleX;
    const y = box.y * scaleY;
    const w = box.w * scaleX;
    const h = box.h * scaleY;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x, y, w, h);
    const label = `${box.label} ${(box.confidence * 100).toFixed(1)}%`;
    const tw = ctx.measureText(label).width;
    const lh = fontSize + 10;
    const ly = Math.max(0, y - lh);
    ctx.fillStyle = color;
    ctx.fillRect(x, ly, tw + 14, lh);
    ctx.fillStyle = '#07100b';
    ctx.fillText(label, x + 7, ly + 5);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

window.addEventListener('resize', drawOverlay);

startStreamBtn.addEventListener('click', async () => {
  const deviceName = cameraSelect.value;
  if (!deviceName) {
    showError('请先选择摄像头设备');
    return;
  }
  startStreamBtn.disabled = true;
  startStreamBtn.textContent = '正在启动…';
  clearError();
  try {
    await fetchJSON('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dshow', deviceName })
    });
    setCameraState(true);
    addLog('info', `已启动视频流: ${deviceName}`);
  } catch (err) {
    showError(err.message);
    startStreamBtn.disabled = false;
  } finally {
    startStreamBtn.textContent = '启动视频流';
  }
});

stopStreamBtn.addEventListener('click', async () => {
  try {
    await fetchJSON('/api/stop', { method: 'POST' });
    setCameraState(false);
    addLog('info', '视频流已停止');
  } catch (err) {
    showError(err.message);
  }
});

startTestBtn.addEventListener('click', () => sendCommand('start_test'));
extinguishBtn.addEventListener('click', () => sendCommand('extinguish_test'));
resetBtn.addEventListener('click', () => sendCommand('reset'));
refreshBtn.addEventListener('click', loadCameras);

loadHealth().then(loadCameras);
connectWebSocket();
setInterval(loadHealth, 5000);
