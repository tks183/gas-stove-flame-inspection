import { parentPort, workerData } from 'node:worker_threads';
import { Detector } from './detector.js';

const detector = new Detector(workerData.config, workerData.rootDir);

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
