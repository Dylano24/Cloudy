import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseWrapper } from '../src/utils/database/wrapper.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { resolveSslConfig, resolvePostgresPoolConfig } from '../src/config/database/postgres.js';
import { createAppealRateLimit } from '../src/web/appealRateLimit.js';

test('concurrent initialization shares a connection and production failure remains retryable', async t => {
  const env = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  t.after(() => { if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; });
  let finish, calls = 0;
  t.mock.method(pgDb, 'connect', () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  t.mock.method(pgDb, 'getLastFailure', () => null);
  const db = new DatabaseWrapper();
  const first = db.initialize(), second = db.initialize();
  assert.equal(calls, 1); finish(false);
  for (const outcome of await Promise.allSettled([first, second])) assert.equal(outcome.reason.code, 'PERSISTENT_STORAGE_REQUIRED');
  assert.equal(db.initialized, false); assert.equal(db.db, null); assert.equal(db.useFallback, false);
  const retry = db.initialize(); assert.equal(calls, 2); finish(true); await retry;
  assert.equal(db.connectionType, 'postgresql');
});

test('explicit TLS verification survives pg connection string parsing and legacy require remains compatible', t => {
  const names = ['POSTGRES_SSL', 'PGSSLMODE', 'POSTGRES_URL', 'POSTGRES_SSL_CA', 'NODE_ENV'];
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of names) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  delete process.env.POSTGRES_SSL; delete process.env.PGSSLMODE;
  process.env.NODE_ENV = 'production';
  process.env.POSTGRES_URL = 'postgresql://localhost/cloudy?sslmode=verify-full';
  assert.equal(resolveSslConfig().rejectUnauthorized, true);
  assert.equal(resolveSslConfig().checkServerIdentity, undefined);
  assert.doesNotMatch(resolvePostgresPoolConfig().connectionString, /sslmode/);
  process.env.POSTGRES_SSL = 'verify-ca';
  assert.equal(resolveSslConfig().rejectUnauthorized, true);
  assert.equal(typeof resolveSslConfig().checkServerIdentity, 'function');
  process.env.POSTGRES_SSL = 'require'; assert.equal(resolveSslConfig().rejectUnauthorized, false);
  process.env.POSTGRES_SSL = 'disable'; assert.equal(resolveSslConfig(), false);
  delete process.env.POSTGRES_SSL;
  process.env.POSTGRES_URL = 'postgresql://localhost/cloudy?ssl=false';
  assert.equal(resolveSslConfig(), false);
  assert.equal(resolvePostgresPoolConfig().ssl, false);
});

test('appeal limits bound repeated emails, total deliveries and key growth with expiration', () => {
  let time = 0;
  const allow = createAppealRateLimit({ now: () => time, maxKeys: 2 });
  assert.equal(allow('A@example.com'), true); assert.equal(allow('a@example.com'), true);
  assert.equal(allow('a@example.com'), true); assert.equal(allow('a@example.com'), false);
  assert.equal(allow('b@example.com'), true); assert.equal(allow('c@example.com'), false);
  time += 3_600_000; assert.equal(allow('c@example.com'), true);
  const global = createAppealRateLimit({ now: () => time });
  for (let i = 0; i < 30; i++) assert.equal(global(i + '@example.com'), true);
  assert.equal(global('next@example.com'), false);
  time += 60_000; assert.equal(global('next@example.com'), true);
});


test('economy SQL failures abort account mutations while missing accounts retain defaults', async t => {
  const { PostgreSQLDatabase } = await import('../src/utils/postgresDatabase.js');
  const { getEconomyData, setEconomyData } = await import('../src/utils/economy.js');
  const database = new PostgreSQLDatabase(); database.isConnected = true;
  let writes = 0;
  database.pool = { query: async () => { throw new Error('query failed'); } };
  const wrapper = new DatabaseWrapper(); wrapper.db = database;
  const guild = '123456789012345678', user = '223456789012345678';
  t.mock.method(wrapper, 'set', async () => { writes++; return true; });
  await assert.rejects(async () => {
    const account = await getEconomyData({ db: wrapper }, guild, user);
    account.wallet += 10;
    await setEconomyData({ db: wrapper }, guild, user, account);
  }, /read failed/);
  assert.equal(writes, 0);
  database.isConnected = false;
  await assert.rejects(database.get('guild:' + guild + ':economy:' + user, {}), /unavailable/);
  database.isConnected = true; database.pool.query = async () => ({ rows: [] });
  const fallback = {};
  assert.strictEqual(await database.get('guild:' + guild + ':economy:' + user, fallback), fallback);
});

test('failed PostgreSQL initialization releases the borrowed client and permits a new connection attempt', async t => {
  const { default: pg } = await import('pg');
  const { PostgreSQLDatabase } = await import('../src/utils/postgresDatabase.js');
  const { pgConfig } = await import('../src/config/database/postgres.js');
  const retries = pgConfig.options.retries; pgConfig.options.retries = 0;
  t.after(() => { pgConfig.options.retries = retries; });
  let released = 0, closed = 0, pools = 0;
  t.mock.method(pg, 'Pool', function () {
    pools++;
    return {
      on() {},
      connect: async () => ({ query: async () => { throw new Error('probe failed'); }, release: () => { released++; } }),
      end: async () => { assert.equal(released, pools); closed++; },
    };
  });
  const database = new PostgreSQLDatabase();
  assert.deepEqual(await Promise.all([database.connect(), database.connect()]), [false, false]);
  assert.equal(pools, 1); assert.equal(closed, 1); assert.equal(database.connectionPromise, null);
  assert.equal(await database.connect(), false);
  assert.equal(pools, 2); assert.equal(closed, 2); assert.equal(released, 2);
});
