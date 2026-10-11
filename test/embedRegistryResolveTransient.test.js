import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { resolveEmbedRegistryRecord } from '../src/services/embedRegistryService.js';

for (const [index, code] of [500, 'AbortError', 50001, 50013, 10008].entries()) {
  test(`embed resolver ${code === 10008 ? 'cleans confirmed missing messages' : `preserves registry on ${code}`}`, async t => {
    let writes = 0;
    const record = { guildId: `registry-transient-${index}`, channelId: 'channel', messageId: 'message', embedIndex: 0, title: 'Protected', source: 'bot-history', snapshot: { title: 'Protected' } };
    t.mock.method(db, 'get', async () => [record]);
    t.mock.method(db, 'set', async () => { writes++; return true; });
    const channel = { messages: { fetch: async () => { throw Object.assign(new Error('fetch failed'), { code }); } } };
    const guild = { id: record.guildId, channels: { cache: new Map([['channel', channel]]) } };
    assert.equal(await resolveEmbedRegistryRecord(guild, record), null);
    assert.equal(writes, code === 10008 ? 1 : 0);
  });
}
