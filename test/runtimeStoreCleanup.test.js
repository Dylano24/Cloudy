import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepExpiredTimestamps, sweepTimestampBuckets } from '../src/utils/runtimeStoreCleanup.js';
import { createSingleFlight } from '../src/utils/singleFlight.js';

test('timestamp bucket cleanup removes stale IP buckets without changing active requests', () => {
  const store = new Map([
    ['expired', [100, 200]],
    ['mixed', [100, 450]],
    ['active', [500, 600]],
  ]);

  const removed = sweepTimestampBuckets(store, 400);

  assert.equal(removed, 1);
  assert.equal(store.has('expired'), false);
  assert.deepEqual(store.get('mixed'), [450]);
  assert.deepEqual(store.get('active'), [500, 600]);
});

test('expired command cooldown cleanup preserves only future expiry timestamps', () => {
  const store = new Map([
    ['old', 999],
    ['now', 1000],
    ['future', 1001],
  ]);

  const removed = sweepExpiredTimestamps(store, 1000);

  assert.equal(removed, 2);
  assert.deepEqual([...store.entries()], [['future', 1001]]);
});

test('single flight shares one in-flight background task and allows the next run afterward', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = createSingleFlight(async value => {
    calls += 1;
    await gate;
    return value;
  });

  const first = run('first');
  const second = run('second');
  assert.strictEqual(first, second);
  assert.equal(calls, 0);

  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'first');

  assert.equal(await run('third'), 'third');
  assert.equal(calls, 2);
});
