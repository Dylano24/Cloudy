import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { logger } from '../src/utils/logger.js';

function fixture(read) {
  const database = new PostgreSQLDatabase();
  database.isConnected = true;
  let active = 0;
  let peak = 0;
  let calls = 0;
  database.pool = {
    async query(sql, params) {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        await setImmediate();
        return { rows: await read(sql, params) };
      } finally {
        active--;
      }
    },
  };
  return { database, stats: () => ({ active, peak, calls }) };
}

test('list overlaps independent reads and preserves canonical deduplication and source order', async () => {
  const { database, stats } = fixture(async (sql, params) => {
    assert.match(sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
    if (sql.includes('FROM cache_data')) return [{ key: 'cache-result' }];
    assert.match(sql, /FROM temp_data/);
    if (params[0] === 'guild:g:reaction_roles:%') {
      // Complete this first query last: completion order must not reorder keys.
      await setImmediate();
      return [{ key: 'guild:g:reaction_roles:a' }];
    }
    assert.equal(params[0], 'reaction_roles:g:%');
    return [{ key: 'reaction_roles:g:a' }, { key: 'reaction_roles:g:b' }];
  });
  assert.deepEqual(await database.list('guild:g:reaction_roles:'), [
    'guild:g:reaction_roles:a', 'guild:g:reaction_roles:b', 'cache-result',
  ]);
  assert.ok(stats().peak > 1, 'independent database reads should overlap');
  assert.equal(stats().calls, 3, 'parallel execution must not add queries');
});

test('broad guild lists bound concurrent reads while retaining structured and singleton keys', async () => {
  const { database, stats } = fixture(sql => {
    if (sql.includes('FROM economy')) return [{ user_id: 'u1' }];
    if (sql.includes('FROM user_levels')) return [{ user_id: 'u2' }];
    if (sql.includes('FROM ticket_data')) return [{ channel_id: 'c1' }];
    if (sql.includes('SELECT config FROM guilds')) return [{ config: { prefix: '!' } }];
    return [];
  });
  // Singleton routing is tested separately; isolate its existing existence contract.
  database.exists = async key => key === 'guild:g:config';
  assert.deepEqual(await database.list('guild:g:'), [
    'guild:g:economy:u1', 'guild:g:leveling:users:u2', 'guild:g:ticket:c1', 'guild:g:config',
  ]);
  assert.ok(stats().peak > 1);
  assert.ok(stats().peak <= 4, 'one list must not flood the connection pool');
  assert.equal(stats().calls, 13);
});

test('a failed list remains empty and all started reads settle without unhandled rejection', async t => {
  t.mock.method(logger, 'error', () => {});
  const { database, stats } = fixture(() => { throw new Error('read failed'); });
  assert.deepEqual(await database.list('guild:g:reaction_roles:'), []);
  await setImmediate();
  assert.equal(stats().active, 0);
});

test('unavailable storage does not issue list queries', async t => {
  t.mock.method(logger, 'warn', () => {});
  const { database, stats } = fixture(() => []);
  database.isConnected = false;
  assert.deepEqual(await database.list('guild:g:'), []);
  assert.equal(stats().calls, 0);
});
