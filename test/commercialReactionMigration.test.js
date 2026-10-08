import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import command from '../src/commands/Reaction_roles/reactroles.js';
import { getReactionRoleKey } from '../src/utils/database/keys.js';

let sequence = 0;
for (const outcome of ['false', 'throw', 'success']) {
  test(`reaction-role dashboard recovery ${outcome === 'success' ? 'migrates after a successful canonical write' : `preserves the old record when the new write returns ${outcome}`}`, async () => {
    const guildId = String(910000000000000000n + BigInt(++sequence));
    const oldId = '920000000000000001';
    const newId = '920000000000000002';
    const panel = { guildId, messageId: oldId, channelId: '930000000000000001', roles: ['940000000000000001'] };
    const oldKey = getReactionRoleKey(guildId, oldId);
    const newKey = getReactionRoleKey(guildId, newId);
    const records = new Map([[oldKey, structuredClone(panel)]]);
    const deleted = [];
    const recovered = { id: newId, author: { id: 'bot' }, embeds: [{ title: 'Saved Panel' }], url: 'https://discord.com/channels/panel', components: [{ type: 1, components: [{ type: 3, custom_id: 'reaction_roles' }] }] };
    const channel = { id: panel.channelId, messages: { fetch: async arg => typeof arg === 'object' ? new Collection([[newId, recovered]]) : arg === newId ? recovered : null } };
    const client = { user: { id: 'bot' }, db: {
      list: async () => [...records.keys()],
      get: async key => structuredClone(records.get(key)),
      set: async (key, value) => {
        assert.equal(key, newKey);
        if (outcome === 'throw') throw new Error('Write rejected');
        if (outcome === 'false') return false;
        records.set(key, structuredClone(value));
        return true;
      },
      delete: async key => { deleted.push(key); records.delete(key); return true; },
    } };
    const executing = command.execute({
      id: guildId, client, guildId, user: { id: 'manager' }, createdTimestamp: Date.now(), deferred: true,
      options: { getSubcommand: () => 'dashboard', getString: () => oldId },
      guild: { id: guildId, name: 'Recovery Guild', channels: { cache: new Collection([[channel.id, channel]]), fetch: async () => channel } },
      channel: { createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) },
      editReply: async () => {}, fetchReply: async () => ({ id: 'dashboard' }),
    });
    if (outcome === 'success') {
      await executing;
      assert.deepEqual(deleted, [oldKey]);
      assert.equal(records.get(newKey).messageId, newId);
    } else {
      let failure;
      await executing.catch(error => { failure = error; });
      assert.deepEqual(deleted, []);
      assert.deepEqual(records.get(oldKey), panel);
      assert.equal(records.has(newKey), false);
      assert.ok(failure, 'A failed migration must surface a persistence error');
    }
  });
}
