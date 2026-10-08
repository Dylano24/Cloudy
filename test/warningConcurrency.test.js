import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getWarningsKey } from '../src/utils/database.js';
import { WarningService } from '../src/services/moderation/warningService.js';

function storage(t, guildId, warnings = []) {
  const key = getWarningsKey(guildId, 'member');
  const values = new Map([[key, structuredClone(warnings)]]);
  t.mock.property(db, 'initialized', true);
  t.mock.method(db, 'get', async storageKey => structuredClone(values.get(storageKey) ?? null));
  t.mock.method(db, 'set', async (storageKey, value) => { values.set(storageKey, structuredClone(value)); return true; });
  return () => structuredClone(values.get(key));
}

function add(guildId, reason) {
  return WarningService.addWarning({ guildId, userId: 'member', moderatorId: 'staff', reason });
}

test('simultaneous warnings persist every record and receive distinct numeric IDs in the same millisecond', async t => {
  const guildId = 'warnings-add-race';
  const read = storage(t, guildId);
  t.mock.method(Date, 'now', () => 1_790_000_000_000);

  const results = await Promise.all([add(guildId, 'First warning'), add(guildId, 'Second warning')]);

  assert.deepEqual(read().map(warning => warning.reason), ['First warning', 'Second warning']);
  assert.equal(new Set(results.map(result => result.id)).size, 2);
  assert.ok(results.every(result => Number.isSafeInteger(result.id)));
  assert.deepEqual(results.map(result => result.totalCount), [1, 2]);
});

test('removing a warning while another is added preserves the new warning', async t => {
  const guildId = 'warnings-remove-race';
  const read = storage(t, guildId, [{ id: 100, reason: 'Old warning', status: 'active' }]);

  await Promise.all([add(guildId, 'New warning'), WarningService.removeWarning(guildId, 'member', 100)]);

  assert.equal(read().find(warning => warning.id === 100).status, 'deleted');
  assert.deepEqual((await WarningService.getWarnings(guildId, 'member')).map(warning => warning.reason), ['New warning']);
});

test('a new warning queued after clear does not restore old warning records', async t => {
  const guildId = 'warnings-clear-race';
  const read = storage(t, guildId, [{ id: 100, reason: 'Old warning', status: 'active' }]);

  await Promise.all([WarningService.clearWarnings(guildId, 'member'), add(guildId, 'New warning')]);

  assert.deepEqual(read().map(warning => warning.reason), ['New warning']);
});

for (const operation of ['add', 'remove', 'clear']) {
  test(`${operation} warning rejects failed persistence instead of reporting success`, async t => {
    const guildId = `warnings-${operation}-write-failure`;
    const read = storage(t, guildId, [{ id: 100, reason: 'Old warning', status: 'active' }]);
    t.mock.method(db, 'set', async () => false);
    const action = operation === 'add' ? add(guildId, 'New warning')
      : operation === 'remove' ? WarningService.removeWarning(guildId, 'member', 100)
        : WarningService.clearWarnings(guildId, 'member');

    await assert.rejects(action);
    assert.deepEqual(read(), [{ id: 100, reason: 'Old warning', status: 'active' }]);
  });

  test(`${operation} warning propagates failed reads without overwriting history`, async t => {
    const guildId = `warnings-${operation}-read-failure`;
    storage(t, guildId);
    const reads = t.mock.method(db, 'get', async () => { throw new Error('database read failed'); });
    const writes = t.mock.method(db, 'set', async () => true);
    const action = operation === 'add' ? add(guildId, 'New warning')
      : operation === 'remove' ? WarningService.removeWarning(guildId, 'member', 100)
        : WarningService.clearWarnings(guildId, 'member');

    await assert.rejects(action);
    assert.deepEqual(reads.mock.calls[0].arguments[2], { strict: true });
    assert.equal(writes.mock.callCount(), 0);
  });
}
