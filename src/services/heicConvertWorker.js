// Runs in a worker thread: decoding a 12-megapixel iPhone photo takes a few
// seconds of CPU and must never block Cloudy's main event loop.
import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';

try {
  const output = await convert({ buffer: Buffer.from(workerData.buffer), format: 'JPEG', quality: 0.9 });
  parentPort.postMessage({ ok: true, buffer: Buffer.from(output) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 200) });
}
