import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileReactionRoleMessages } from '../src/services/reactionRoleService.js';
import { getReactionRoleKey } from '../src/utils/database/keys.js';

function fixture(t, guildId, phase, errorCode) {
  const channelId = '222222222222222222';
  const messageId = '333333333333333333';
  const record = { guildId, channelId, messageId, roles: [] };
  const unavailable = async () => { throw Object.assign(new Error('Discord lookup failed'), { code: errorCode }); };
  const channel = { isTextBased: () => true, messages: { fetch: phase === 'message' ? unavailable : async () => ({ id: messageId }) } };
  const guild = { channels: { cache: new Map(phase === 'channel' ? [] : [[channelId, channel]]), fetch: unavailable } };
  const deleted = t.mock.fn(async () => true);
  return {
    client: {
      guilds: { cache: new Map(phase === 'guild' ? [] : [[guildId, guild]]), fetch: unavailable },
      db: { list: async () => [getReactionRoleKey(guildId, messageId)], get: async () => structuredClone(record), delete: deleted },
    },
    deleted,
  };
}

for (const [index, phase] of ['guild', 'channel', 'message'].entries()) {
  test(`reaction-role reconciliation preserves saved data when ${phase} lookup fails temporarily`, async t => {
    const guildId = `11111111111111111${index}`;
    const { client, deleted } = fixture(t, guildId, phase, 50013);

    const result = await reconcileReactionRoleMessages(client, guildId);

    assert.equal(deleted.mock.callCount(), 0);
    assert.equal(result.removedMessages, 0);
    assert.equal(result.errors, 1);
  });

  test(`reaction-role reconciliation still removes records for confirmed deleted ${phase}`, async t => {
    const guildId = `11111111111111112${index}`;
    const code = { guild: 10004, channel: 10003, message: 10008 }[phase];
    const { client, deleted } = fixture(t, guildId, phase, code);

    const result = await reconcileReactionRoleMessages(client, guildId);

    assert.equal(deleted.mock.callCount(), 1);
    assert.equal(result.removedMessages, 1);
    assert.equal(result.errors, 0);
  });
}
