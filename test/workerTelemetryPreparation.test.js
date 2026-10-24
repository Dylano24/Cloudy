import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createAnonymousLatencySample,
  parseAnonymousLatencySample,
  publishAnonymousLatencySample,
  consumeAnonymousLatencySample,
} from '../src/utils/workerLatencyTelemetry.js';

test('worker telemetry is anonymous, bounded, and groups the original command', async () => {
  const sample = createAnonymousLatencySample({
    command: 'report_case',
    action: 'read',
    phase: 'handler_complete',
    elapsedMs: 910.4,
    userId: '123456789012345678',
    messageId: '987654321098765432',
    payload: 'Do not copy personal data.',
  }, new Date('2026-10-07T21:30:00.000Z'));

  assert.deepEqual(sample, {
    version: 1, hour: '2026-10-07T21', command: 'report_case',
    action: 'read', phase: 'handler_complete', elapsedMs: 910,
  });
  assert.doesNotMatch(JSON.stringify(sample), /Do not copy personal data|123456789012345678|987654321098765432/);
  assert.deepEqual(parseAnonymousLatencySample(JSON.stringify(sample)), sample);

  const writes = [];
  assert.equal(await consumeAnonymousLatencySample(JSON.stringify(sample), async (...args) => {
    writes.push(args);
    return true;
  }), true);
  assert.deepEqual(writes, [['2026-10-07T21', 'report_case:read:handler_complete', 910]]);
});

test('worker telemetry rejects malformed and untrusted queue messages', async () => {
  assert.equal(createAnonymousLatencySample({ elapsedMs: 100000 }), null);
  assert.equal(parseAnonymousLatencySample('{'), null);
  assert.equal(parseAnonymousLatencySample('[]'), null);
  assert.equal(parseAnonymousLatencySample(JSON.stringify({
    version: 1, hour: '2026-10-07T21', command: 'report_case',
    action: 'read_123456789012345678', phase: 'ack', elapsedMs: 1000,
  })), null);
  assert.equal(parseAnonymousLatencySample(JSON.stringify({
    version: 1, hour: '2026-10-07T21', command: 'report_case',
    action: 'read', phase: 'ack', elapsedMs: -100,
  })), null);
  assert.equal(await consumeAnonymousLatencySample('{}', async () => {
    assert.fail('invalid jobs must not touch Redis rollups');
  }), false);
});

test('worker is opt-in and cannot start the Discord Gateway or mutate business data', async () => {
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts.start, 'node scripts/register-cloudy-guild-commands.js && exec node src/bootstrap.js');
  assert.equal(scripts['worker:start'], 'node worker/index.js');
  const worker = fs.readFileSync('worker/index.js', 'utf8');
  assert.match(worker, /CLOUDY_WORKER_ENABLED !== '1'/);
  assert.match(worker, /REDIS_URL/);
  assert.doesNotMatch(worker, /DISCORD_TOKEN|new Client\(|login\(|guild\.channels|client\.db\.set/);

  assert.equal(await publishAnonymousLatencySample({
    command: 'report_case', action: 'read', phase: 'ack', elapsedMs: 800,
  }, false), false);
});
