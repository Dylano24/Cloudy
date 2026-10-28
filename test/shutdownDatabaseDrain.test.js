import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { waitForPoolIdle } from '../src/utils/database/drain.js';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

test('shutdown waits for a busy pool to finish, then for a quiet period', async () => {
  const c = clock();
  const pool = { totalCount: 2, idleCount: 1, waitingCount: 0 };
  const done = waitForPoolIdle(pool, { ...c, quietMs: 500, maxMs: 4000, intervalMs: 50,
    sleep: async ms => { await c.sleep(ms); if (c.now() >= 1200) pool.idleCount = 2; } });
  const result = await done;
  assert.equal(result.idle, true);
  assert.ok(result.waitedMs >= 1700 && result.waitedMs <= 1800, String(result.waitedMs));
});

test('a query issued during the quiet period restarts it', async () => {
  const c = clock();
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const result = await waitForPoolIdle(pool, { ...c, quietMs: 500, maxMs: 4000, intervalMs: 50,
    sleep: async ms => {
      await c.sleep(ms);
      pool.idleCount = c.now() >= 300 && c.now() < 400 ? 0 : 1;
    } });
  assert.equal(result.idle, true);
  assert.ok(result.waitedMs >= 900, String(result.waitedMs));
});

test('shutdown never waits longer than the limit and reports a busy pool', async () => {
  const c = clock();
  const result = await waitForPoolIdle({ totalCount: 3, idleCount: 0, waitingCount: 2 },
    { ...c, quietMs: 500, maxMs: 4000, intervalMs: 50 });
  assert.deepEqual(result, { idle: false, waitedMs: 4000 });
});

test('no pool (memory storage or already closed) does not delay shutdown', async () => {
  assert.deepEqual(await waitForPoolIdle(null), { idle: true, waitedMs: 0 });
  assert.deepEqual(await waitForPoolIdle({}), { idle: true, waitedMs: 0 });
});

test('the bot drains the pool after destroying Discord and before closing the database', () => {
  const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const shutdown = source.slice(source.indexOf('async shutdown('));
  const destroy = shutdown.indexOf('this.destroy()');
  const drain = shutdown.indexOf('waitForPoolIdle(this.db.db.pool');
  const close = shutdown.indexOf('this.db.db.close()');
  assert.ok(destroy > 0 && drain > destroy && close > drain);
});
