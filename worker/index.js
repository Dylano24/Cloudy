import 'dotenv/config';
import { createServer } from 'node:http';
import {
  redisPing,
  redisTakeLatencySample,
  redisIncrementLatencyRollup,
} from '../src/utils/redisCache.js';
import { consumeAnonymousLatencySample } from '../src/utils/workerLatencyTelemetry.js';

// Safe, dedicated Railway worker. No Discord Gateway client, bot token,
// PostgreSQL write access, or business-action handlers are loaded here.
if (process.env.CLOUDY_WORKER_ENABLED !== '1') {
  console.error('[CLOUDY_WORKER] Disabled. Set CLOUDY_WORKER_ENABLED=1 only on a dedicated service.');
  process.exitCode = 1;
} else if (!process.env.REDIS_URL) {
  console.error('[CLOUDY_WORKER] REDIS_URL is required. No jobs have been consumed.');
  process.exitCode = 1;
} else {
  const port = Number(process.env.PORT || 8080);
  let stopping = false;
  let reachable = false;
  let running = null;
  let consumed = 0;
  let rejected = 0;

  const server = createServer((req, res) => {
    const ready = reachable && !stopping;
    const status = req.url === '/ready' ? (ready ? 200 : 503) : 200;
    if (req.url !== '/ready' && req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable',
      role: 'cloudy-background-worker', consumed, rejected }));
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('[CLOUDY_WORKER] Health listener started on port ' + port);
  });

  const next = async () => {
    if (stopping) return;
    running = (async () => {
      reachable = await redisPing();
      if (!reachable) return;
      // Bound work per poll so the Worker stays responsive during high load.
      for (let i = 0; i < 25 && !stopping; i += 1) {
        const raw = await redisTakeLatencySample();
        if (raw === null) break;
        try {
          const result = await consumeAnonymousLatencySample(raw, redisIncrementLatencyRollup);
          if (result) consumed++;
          else rejected++;
        } catch (error) {
          rejected++;
          console.warn('[CLOUDY_WORKER] Non-critical telemetry sample failed:', error.message);
        }
      }
    })();
    try {
      await running;
    } catch (error) {
      reachable = false;
      console.warn('[CLOUDY_WORKER] Temporary Redis poll failure:', error.message);
    } finally {
      running = null;
      if (!stopping) {
        const timer = setTimeout(next, reachable ? 250 : 5_000);
        timer.unref?.();
      }
    }
  };

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    reachable = false;
    try { await running; } catch { /* Best effort. */ }
    server.close(() => { process.exitCode = 0; });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  void next();
}
