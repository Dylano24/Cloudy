import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { DatabaseWrapper } from '../src/utils/database/wrapper.js';

for (const key of ['guild:guild:warnings:member', 'guild:guild:birthdays', 'guild:guild:giveaways']) {
  test(`strict reads of ${key} propagate failures without returning an empty collection`, async () => {
    const database = new PostgreSQLDatabase();
    database.isConnected = true;
    const failure = new Error('connection lost');
    database.pool = { query: async () => { throw failure; } };
    const fallback = [];
    assert.strictEqual(await database.get(key, fallback), fallback);
    await assert.rejects(database.get(key, fallback, { strict: true }), error => error === failure);
  });
}

test('strict reads reject unavailable storage but still return defaults for absent rows', async () => {
  const database = new PostgreSQLDatabase();
  await assert.rejects(database.get('guild:guild:birthdays', {}, { strict: true }));
  database.isConnected = true;
  database.pool = { query: async () => ({ rows: [] }) };
  const fallback = {};
  assert.deepEqual(await database.get('guild:guild:birthdays', fallback, { strict: true }), fallback);
});

test('the storage wrapper forwards strict read options', async () => {
  const wrapper = new DatabaseWrapper();
  const failure = new Error('strict read failed');
  wrapper.db = { get: async (_key, _default, options) => {
    if (options?.strict) throw failure;
    return [];
  } };
  await assert.rejects(wrapper.get('guild:guild:warnings:member', [], { strict: true }), error => error === failure);
});
