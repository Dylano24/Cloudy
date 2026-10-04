import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { logger } from '../src/utils/logger.js';

const canonicalKey = 'guild:guild:reaction_roles:message';
const legacyKey = 'reaction_roles:guild:message';

function databaseFixture(rows = []) {
  const calls = [];
  const database = new PostgreSQLDatabase();
  database.isConnected = true;
  database.pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const candidates = Array.isArray(params[0]) ? params[0] : [params[0]];
      return { rows: rows.filter(row => candidates.includes(row.key)
        && (row.expiresAt == null || row.expiresAt > Date.now())) };
    },
  };
  return { database, calls };
}

test('canonical values win over legacy values regardless of PostgreSQL row order', async () => {
  const current = { roles: ['current'] };
  const old = { roles: ['legacy'] };
  for (const requestedKey of [canonicalKey, legacyKey]) {
    const { database, calls } = databaseFixture([
      { key: legacyKey, value: old },
      { key: canonicalKey, value: current },
    ]);
    assert.deepEqual(await database.get(requestedKey), current);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [[canonicalKey, legacyKey]]);
    assert.match(calls[0].sql, /key = ANY\(\$1::text\[\]\)/);
    assert.match(calls[0].sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
  }
});

test('absent or expired canonical rows fall back to the live legacy value in one read', async () => {
  for (const canonicalRows of [[], [{ key: canonicalKey, value: 'expired', expiresAt: Date.now() - 1 }]]) {
    const { database, calls } = databaseFixture([
      ...canonicalRows,
      { key: legacyKey, value: { roles: ['legacy'] } },
    ]);
    assert.deepEqual(await database.get(canonicalKey), { roles: ['legacy'] });
    assert.equal(calls.length, 1);
  }
});

test('missing and expired candidates return the caller default unchanged with one query', async () => {
  const fallback = { roles: [] };
  for (const rows of [[], [{ key: legacyKey, value: 'expired', expiresAt: Date.now() - 1 }]]) {
    const { database, calls } = databaseFixture(rows);
    assert.strictEqual(await database.get(canonicalKey, fallback), fallback);
    assert.equal(calls.length, 1);
  }
});

test('values equal to a primitive default retain the existing legacy fallback behavior', async () => {
  for (const fallback of [null, 0, false, '']) {
    const { database, calls } = databaseFixture([
      { key: canonicalKey, value: fallback },
      { key: legacyKey, value: 'legacy' },
    ]);
    assert.equal(await database.get(canonicalKey, fallback), 'legacy');
    assert.equal(calls.length, 1);
  }
});

test('falsy stored values are kept when they differ from the default', async () => {
  for (const value of [0, false, '']) {
    const { database } = databaseFixture([
      { key: canonicalKey, value },
      { key: legacyKey, value: 'legacy' },
    ]);
    assert.equal(await database.get(canonicalKey), value);
  }
});

test('original-key precedence stays ahead of generated legacy aliases and parameters stay bound', async () => {
  const originalKey = "manual:'; SELECT 1; --";
  const { database, calls } = databaseFixture([
    { key: legacyKey, value: 'generated alias' },
    { key: originalKey, value: 'original' },
  ]);
  assert.equal(await database._getWithLegacyFallback(canonicalKey, originalKey, null), 'original');
  assert.deepEqual(calls[0].params, [[canonicalKey, originalKey, legacyKey]]);
  assert.equal(calls[0].sql.includes(originalKey), false);
});

test('keys with no legacy alias retain the single-key read path', async () => {
  const key = 'global:report:guild:message';
  const stored = { state: 'active' };
  const { database, calls } = databaseFixture([{ key, value: stored }]);
  assert.deepEqual(await database.get(key), stored);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [key]);
  assert.match(calls[0].sql, /key = \$1/);
});

test('query failures preserve get defaults and never start another database read', async t => {
  t.mock.method(logger, 'error', () => {});
  const { database, calls } = databaseFixture();
  const fallback = { unchanged: true };
  database.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    throw new Error('database unavailable');
  };
  assert.strictEqual(await database.get(canonicalKey, fallback), fallback);
  assert.equal(calls.length, 1);
});

test('unavailable PostgreSQL preserves the default without issuing a query', async t => {
  t.mock.method(logger, 'warn', () => {});
  const { database, calls } = databaseFixture();
  database.isConnected = false;
  assert.equal(await database.get(canonicalKey, 'default'), 'default');
  assert.equal(calls.length, 0);
});
