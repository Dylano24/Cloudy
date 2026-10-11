import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLevelRoles } from '../src/services/leveling/levelRoleSyncService.js';

for (const missing of [false, true]) {
  test(`level reward is ${missing ? 'pruned on confirmed absence' : 'preserved on a temporary role lookup failure'}`, async () => {
    const guildId = missing ? '920000000000000001' : '920000000000000002';
    const guild = { id: guildId, roles: { cache: new Map(), fetch: async () => {
      if (missing) return null;
      throw new Error('network error');
    } } };
    const writes = [];
    const client = { guilds: { cache: new Map([[guildId, guild]]) }, db: {
      get: async () => ({ leveling: { enabled: true, roleRewards: { 5: '921111111111111111' } } }),
      set: async (_key, value) => { writes.push(value); return true; }, list: async () => [],
    } };
    const result = await reconcileLevelRoles(client);
    assert.equal(result.prunedRewardEntries, missing ? 1 : 0);
    assert.equal(writes.length, missing ? 1 : 0);
    assert.equal(result.errors, missing ? 0 : 1);
  });
}
