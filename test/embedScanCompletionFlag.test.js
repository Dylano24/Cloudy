import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import fullHistory from '../src/events/embedBuilderFullHistoryIndexReady.js';
import { db } from '../src/utils/database.js';

for (const failing of [true, false]) {
  test(`history completion is ${failing ? 'not recorded after a fetch failure' : 'recorded after a complete scan'}`, async t => {
    let callback;
    t.mock.method(globalThis, 'setTimeout', fn => { callback = fn; return { unref() {} }; });
    const writes = [];
    t.mock.method(db, 'get', async () => 0);
    t.mock.method(db, 'set', async (key, value) => { writes.push([key, value]); return true; });
    const channel = { id: 'channel', type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => { if (failing) throw new Error('network failed'); return new Collection(); } } };
    const guild = { id: `scan-completion-${failing}`, members: { me: {} }, channels: { cache: new Collection([['channel', channel]]) } };
    fullHistory.execute({ user: { id: 'bot' }, guilds: { cache: new Collection([[guild.id, guild]]) } });
    await callback();
    assert.equal(writes.some(([key]) => key.includes('full-history-index')), !failing);
  });
}
