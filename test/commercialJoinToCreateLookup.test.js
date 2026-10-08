import test from 'node:test';
import assert from 'node:assert/strict';
import command from '../src/commands/JoinToCreate/jointocreate.js';

for (const code of ['ECONNRESET', 50013, 10003]) {
  test(`Join to Create setup ${code === 10003 ? 'removes confirmed missing triggers' : `preserves trigger configuration after Discord ${code}`}`, async () => {
    const guildId = `jtc-lookup-${code}`;
    const original = { triggerChannels: ['existing-trigger'], enabled: true, channelOptions: { 'existing-trigger': { nameTemplate: 'Saved room' } }, temporaryChannels: { room: { triggerChannelId: 'existing-trigger' } } };
    let stored = structuredClone(original);
    let writes = 0;
    let createAttempts = 0;
    const client = { db: {
      get: async key => { assert.equal(key, `guild:${guildId}:jointocreate`); return structuredClone(stored); },
      set: async (_key, value) => { writes++; stored = structuredClone(value); return true; },
    } };
    await command.execute({
      id: guildId, guildId, createdTimestamp: Date.now(), deferred: true,
      user: { id: 'manager' }, member: { permissions: { has: () => true } },
      guild: { id: guildId, channels: {
        fetch: async () => { throw Object.assign(new Error('Discord lookup failed'), { code }); },
        create: async () => { createAttempts++; throw new Error('Fixture stops before channel creation'); },
      } },
      options: { getSubcommand: () => 'setup', getChannel: () => null, getString: () => null, getInteger: () => null },
      editReply: async () => {},
    }, {}, client);
    if (code === 10003) {
      assert.equal(writes, 1);
      assert.deepEqual(stored.triggerChannels, []);
      assert.equal(createAttempts, 1);
    } else {
      assert.equal(writes, 0);
      assert.deepEqual(stored, original);
      assert.equal(createAttempts, 0);
    }
  });
}
