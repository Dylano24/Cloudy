import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../src/events/interactionCreate.js';
import { getReactionRoleKey } from '../src/utils/database/keys.js';

for (const [index, failure] of ['cache miss', 50001, 'AbortError', 10008].entries()) {
  test(`reaction role autocomplete preserves records on ${failure}`, async () => {
    const guildId = `93000000000000000${index}`;
    const channelId = '931111111111111111';
    const messageId = '932222222222222222';
    let deletes = 0;
    const replies = [];
    const channel = { messages: { fetch: async () => { throw Object.assign(new Error('lookup failed'), { code: failure }); } } };
    const guild = { id: guildId, channels: { cache: new Map(failure === 'cache miss' ? [] : [[channelId, channel]]) } };
    const client = { commands: new Map(), db: { list: async () => [getReactionRoleKey(guildId, messageId)], get: async () => ({ guildId, channelId, messageId, roles: {} }), delete: async () => { deletes++; } } };
    await router.execute({ guild, guildId, user: { id: '933333333333333333' }, commandName: 'reactroles',
      isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isAutocomplete: () => true,
      options: { getFocused: () => ({ name: 'panel', value: '' }) }, respond: async choices => { replies.push(choices); },
    }, client);
    assert.equal(deletes, 0);
    assert.deepEqual(replies, [[]]);
  });
}
