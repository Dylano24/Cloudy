import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function startMonitor(t, token = 'test-monitor-secret') {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudy-monitor-security-'));
  // Stub every external fetch before importing the real monitor entry point.
  const entry = new URL('../monitor/index.js', import.meta.url).href;
  const source = `
    globalThis.fetch = async url => ({
      ok: true, status: 200,
      text: async () => String(url).endsWith('/health')
        ? '{"status":"healthy"}' : String(url).endsWith('/ready')
          ? '{"ready":true}' : '{"workflow_runs":[]}',
    });
    const http = await import('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    await import(${JSON.stringify(entry)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, PORT: '0', DATA_DIR: directory, MONITOR_WEBHOOK_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Monitor did not start: ${errors}`)), 5000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/TEST_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Monitor exited: ${errors}`)); });
  });
  return { port, child };
}

function request(port, { method = 'GET', url = '/status', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      let value = '';
      res.on('data', chunk => { value += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(value) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const event = { type: 'deployment.crashed', service: { id: 'bot-service' }, deployment: { id: 'bot-deployment' } };

test('monitor rejects unauthorized incident writes without altering handoff evidence', async t => {
  const { port } = await startMonitor(t);
  for (const headers of [{}, { authorization: 'Bearer incorrect' }]) {
    const response = await request(port, { method: 'POST', url: '/railway-webhook', headers, body: event });
    assert.equal(response.status, 403);
  }
  const status = await request(port);
  assert.equal(status.body.latestRailwayEvent, null);
  assert.deepEqual(status.body.incidents, []);
});

test('monitor accepts authenticated Railway events by header or configured webhook URL', async t => {
  const { port } = await startMonitor(t);
  for (const options of [
    { headers: { authorization: 'Bearer test-monitor-secret' }, url: '/railway-webhook' },
    { url: '/railway-webhook?token=test-monitor-secret' },
  ]) {
    const response = await request(port, { ...options, method: 'POST', body: event });
    assert.equal(response.status, 200);
  }
  const status = await request(port);
  assert.equal(status.body.latestRailwayEvent.deploymentId, 'bot-deployment');
  assert.equal(status.body.incidents.length, 1);
  assert.equal(JSON.stringify(status.body).includes('test-monitor-secret'), false);
});

test('monitor rejects webhook writes when the shared secret has not been configured', async t => {
  const { port } = await startMonitor(t, '');
  const response = await request(port, { method: 'POST', url: '/railway-webhook', body: event });
  assert.equal(response.status, 503);
  assert.equal((await request(port)).body.latestRailwayEvent, null);
});

test('an invalid Host header cannot terminate the monitor or break health checks', async t => {
  const { port, child } = await startMonitor(t);
  const result = await request(port, { url: '/health', headers: { host: '[' } }).catch(error => ({ error }));
  assert.equal(result.status, 200);
  assert.equal(child.exitCode, null);
  assert.equal((await request(port, { url: '/health' })).status, 200);
});
