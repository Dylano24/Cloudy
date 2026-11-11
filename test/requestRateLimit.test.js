import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { isHealthCheck, requestLimitFor, trustProxySetting } from '../src/utils/requestRateLimit.js';

const general = { windowMs: 15 * 60_000, max: 100 };

test('the browser editor, hosted media and everything else each have their own budget', () => {
  for (const path of ['/embed-color', '/api/embed-color/abc123']) {
    assert.deepEqual(requestLimitFor(path, general), { name: 'editor', windowMs: 60_000, max: 1_200 });
  }
  for (const path of ['/cloudy-embed-media/banner.gif', '/deleted-media/token', '/deleted-media/token/video']) {
    assert.deepEqual(requestLimitFor(path, general), { name: 'media', windowMs: 60_000, max: 600 });
  }
  for (const path of ['/', '/api/appeals', '/api/dashboard/v1/meta', '/api/game/v1/events', '/api/website-assistant/chat', '/embed-colors']) {
    assert.deepEqual(requestLimitFor(path, general), { name: 'general', ...general });
  }
  // One active editing session: a heartbeat every 20 seconds plus an edit per keystroke.
  assert.ok(requestLimitFor('/api/embed-color/x', general).max >= 20 * 60, 'room for 20 requests a second');
});

test('health checks are never limited', () => {
  assert.equal(isHealthCheck('GET', '/health'), true);
  assert.equal(isHealthCheck('GET', '/ready'), true);
  assert.equal(isHealthCheck('POST', '/health'), false);
  assert.equal(isHealthCheck('GET', '/healthz'), false);
});

test('the proxy in front of Cloudy is trusted on Railway only, unless set explicitly', () => {
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ RAILWAY_ENVIRONMENT_ID: 'x' }), 1);
  assert.equal(trustProxySetting({ RAILWAY_PROJECT_ID: 'x' }), 1);
  assert.equal(trustProxySetting({ RAILWAY_PROJECT_ID: 'x', TRUST_PROXY_HOPS: '0' }), false);
  assert.equal(trustProxySetting({ TRUST_PROXY_HOPS: '2' }), 2);
  assert.equal(trustProxySetting({ TRUST_PROXY_HOPS: 'true' }), false, 'never "trust everything"');
});

test('behind one proxy each visitor is seen by their own address and cannot fake another', async t => {
  const app = express();
  app.set('trust proxy', trustProxySetting({ RAILWAY_PROJECT_ID: 'x' }));
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const ask = async forwarded => (await (await fetch(`http://127.0.0.1:${server.address().port}/ip`,
    { headers: forwarded ? { 'x-forwarded-for': forwarded } : {} })).json()).ip;
  assert.equal(await ask('203.0.113.7'), '203.0.113.7');
  assert.equal(await ask('198.51.100.9'), '198.51.100.9');
  // The proxy adds the real address last; whatever the visitor sent before it is ignored.
  assert.equal(await ask('10.0.0.1, 203.0.113.7'), '203.0.113.7');
});

test('the limiter in app.js counts per visitor and per kind of request, after the health-check exemption', () => {
  const source = readFileSync('src/app.js', 'utf8');
  assert.match(source, /app\.set\('trust proxy', trustProxySetting\(\)\);/);
  const limiter = source.slice(source.indexOf('const requestCounts = new Map();'), source.indexOf('registerDashboardApi(app, this, express);'));
  assert.match(limiter, /if \(isHealthCheck\(req\.method, req\.path\)\) return next\(\);\s*\/\/[^\n]*\n\s*const limit = requestLimitFor\(req\.path, \{ windowMs, max: maxRequests \}\);\s*const key = `\$\{limit\.name\}:\$\{req\.ip\}`;/);
  assert.match(limiter, /if \(times\.length >= limit\.max\) \{\s*return res\.status\(429\)/);
});
