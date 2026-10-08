import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database/wrapper.js';
import { generateCaseId, storeModerationCase, getModerationCases } from '../src/utils/moderation.js';

test('concurrent moderation cases retain unique IDs and all stored history entries', async t => {
  const values = new Map();
  t.mock.method(db, 'get', async (key, fallback = null) => structuredClone(values.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { values.set(key, structuredClone(value)); return true; });
  const guildId = '123456789012345678';
  const caseIds = await Promise.all(Array.from({ length: 12 }, () => generateCaseId({}, guildId)));
  assert.equal(new Set(caseIds).size, 12);
  assert.deepEqual([...caseIds].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  await Promise.all(caseIds.map(caseId => storeModerationCase({
    guildId, caseId, caseData: { action: 'warn', targetUserId: String(caseId) },
  })));
  const history = await getModerationCases(guildId);
  assert.equal(history.length, 12);
  assert.equal(new Set(history.map(entry => entry.caseId)).size, 12);
});

test('moderation history is not replaced after a failed storage read', async t => {
  t.mock.method(db, 'get', async (_key, _fallback, options) => {
    assert.deepEqual(options, { strict: true });
    throw new Error('read failed');
  });
  const writes = t.mock.method(db, 'set', async () => true);
  assert.equal(await storeModerationCase({ guildId: 'read-failure', caseId: 1, caseData: { action: 'warn' } }), false);
  assert.equal(writes.mock.callCount(), 0);
});

for (const failedKey of ['moderation_case_write-failure_1', 'moderation_cases_list_write-failure']) {
  test(`moderation storage does not report success after ${failedKey} fails`, async t => {
    t.mock.method(db, 'get', async (_key, fallback) => structuredClone(fallback));
    t.mock.method(db, 'set', async key => key !== failedKey);
    assert.equal(await storeModerationCase({ guildId: 'write-failure', caseId: 1, caseData: { action: 'warn' } }), false);
  });
}
