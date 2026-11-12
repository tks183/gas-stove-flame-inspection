import { parentPort, workerData } from 'node:worker_threads';

const config = workerData.config;
const rootDir = workerData.rootDir;
const useRknn = process.platform !== 'win32' && config.model?.linux?.runtime === 'rknn';

let detector;
if (useRknn) {
  const { RknnDetector } = await import('./rknn-detector.js');
  const platformModel = { ...config.model, ...config.model.linux };
  detector = new RknnDetector({ ...config, model: platformModel }, rootDir);
} else {
  const { Detector } = await import('./detector.js');
  detector = new Detector(config, rootDir);
}

try {
  await detector.load();
  parentPort.postMessage({ type: 'ready', backend: detector.backend });
} catch (err) {
  parentPort.postMessage({ type: 'fatal', error: err.message });
}

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'detect') return;
  try {
    const jpeg = Buffer.from(msg.buffer);
    const result = await detector.detect(jpeg);
    parentPort.postMessage({ type: 'result', id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'infer-error', id: msg.id, error: err.message });
  }
});
