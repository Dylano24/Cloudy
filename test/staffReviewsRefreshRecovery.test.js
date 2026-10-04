import test from 'node:test';
import assert from 'node:assert/strict';
import staffReviewsReady from '../src/events/staffReviewsReady.js';
import { logger } from '../src/utils/logger.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });

test('a failed initial staff panel lookup does not stop periodic refreshes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const warnings = t.mock.method(logger, 'warn', () => {});
  let calls = 0;
  const client = { channels: { cache: new Map(), fetch: () => {
    calls++;
    if (calls === 1) throw new Error('Temporary lookup failure');
    return Promise.resolve(null);
  } }, guilds: { cache: new Map() } };
  await staffReviewsReady.execute(client);
  t.mock.timers.tick(2500); await settle();
  assert.equal(calls, 1);
  assert.equal(warnings.mock.callCount(), 1);
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  assert.equal(calls, 2);
  assert.equal(warnings.mock.callCount(), 1);
});

test('slow staff panel refreshes cannot overlap and refresh again after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0, release;
  const client = { channels: { cache: new Map(), fetch: async () => {
    calls++;
    if (calls === 1) return null;
    return new Promise(resolve => { release = resolve; });
  } }, guilds: { cache: new Map() } };
  await staffReviewsReady.execute(client);
  t.mock.timers.tick(2500); await settle();
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  assert.equal(calls, 2);
  release(null); await settle();
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  assert.equal(calls, 3);
  release(null); await settle();
});
