import test from 'node:test';
import assert from 'node:assert/strict';
import { setBirthday, deleteBirthday } from '../src/utils/database.js';
import { saveGiveaway, deleteGiveaway } from '../src/utils/giveaways.js';

function storage(initial = {}) {
  let value = structuredClone(initial);
  const calls = [];
  const client = { db: {
    get: async (...args) => { calls.push(args); return structuredClone(value); },
    set: async (_key, next) => { value = structuredClone(next); return true; },
  } };
  return { client, calls, read: () => value };
}

test('simultaneous birthday registrations retain every member', async () => {
  const fixture = storage();
  await Promise.all(Array.from({ length: 10 }, (_, i) => setBirthday(fixture.client, 'birthday-race', `member${i}`, 1, i + 1)));
  assert.equal(Object.keys(fixture.read()).length, 10);
});

test('simultaneous giveaway creation retains every message', async () => {
  const fixture = storage();
  await Promise.all(Array.from({ length: 10 }, (_, i) => saveGiveaway(fixture.client, 'giveaway-race', { messageId: `message${i}` })));
  assert.equal(Object.keys(fixture.read()).length, 10);
});

const operations = {
  'birthday save': fixture => setBirthday(fixture.client, 'failure', 'member', 1, 1),
  'birthday delete': fixture => deleteBirthday(fixture.client, 'failure', 'member'),
  'giveaway save': fixture => saveGiveaway(fixture.client, 'failure', { messageId: 'message' }),
  'giveaway delete': fixture => deleteGiveaway(fixture.client, 'failure', 'message'),
};
for (const [name, operation] of Object.entries(operations)) {
  test(`${name} does not report success when storage rejects the write`, async () => {
    const fixture = storage({ member: { month: 1, day: 1 }, message: { messageId: 'message' } });
    fixture.client.db.set = async () => false;
    assert.equal(await operation(fixture), false);
  });
  test(`${name} does not overwrite data after a failed read`, async () => {
    const fixture = storage();
    let writes = 0;
    fixture.client.db.get = async (_key, _fallback, options) => {
      assert.deepEqual(options, { strict: true });
      throw new Error('database read failed');
    };
    fixture.client.db.set = async () => { writes++; return true; };
    assert.equal(await operation(fixture), false);
    assert.equal(writes, 0);
  });
}
