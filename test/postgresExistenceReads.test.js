import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { logger } from '../src/utils/logger.js';

for (const key of ['temp:large-document', 'cache:large-document', 'reaction_roles:g:m']) {
  test(`existence of ${key} returns a boolean without transferring the document`, async () => {
    const db = new PostgreSQLDatabase();
    db.isConnected = true;
    let calls = 0;
    db.pool = { query: async (sql, params) => {
      calls++;
      assert.match(sql, /SELECT EXISTS/);
      assert.match(sql, /value <> 'null'::jsonb/);
      assert.match(sql, /expires_at IS NULL OR expires_at > NOW\(\)/);
      assert.equal(sql.includes(key), false);
      assert.ok(params[0].includes(key));
      return { rows: [{ present: true }] };
    } };
    assert.equal(await db.exists(key), true);
    assert.equal(calls, 1);
  });
}

test('missing, expired and JSON null values preserve the false existence result', async () => {
  const db = new PostgreSQLDatabase();
  db.isConnected = true;
  db.pool = { query: async () => ({ rows: [{ present: false }] }) };
  assert.equal(await db.exists('temp:missing'), false);
});

test('structured existence keeps collection and economy semantics', async () => {
  const db = new PostgreSQLDatabase();
  db.isConnected = true;
  db.pool = {};
  for (const value of [null, {}, [], { wallet: 0 }]) {
    db.get = async () => value;
    assert.equal(await db.exists('guild:g:economy:u'), value !== null);
  }
});

test('existence failures remain false and unavailable storage issues no queries', async t => {
  t.mock.method(logger, 'error', () => {});
  const db = new PostgreSQLDatabase();
  let calls = 0;
  db.pool = { query: async () => { calls++; throw new Error('unavailable'); } };
  assert.equal(await db.exists('temp:key'), false);
  assert.equal(calls, 0);
  db.isConnected = true;
  assert.equal(await db.exists('temp:key'), false);
  assert.equal(calls, 1);
});
