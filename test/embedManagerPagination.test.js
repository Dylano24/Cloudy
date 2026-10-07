import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelPayload, createEmbedManagerChannelPager } from '../src/services/embedManagerService.js';

test('page navigation reuses session records and preserves page payloads', () => {
  const channels = new Map(Array.from({ length: 67 }, (_, i) => [String(i), {
    id: String(i), name: `channel-${i}`, type: 0, rawPosition: i,
    messages: { fetch: async () => null },
  }]));
  const guild = { id: 'g', channels: { cache: channels } };
  let reads = 0;
  const records = new Proxy([], { get(target, key) {
    if (key === Symbol.iterator) reads++;
    return Reflect.get(target, key);
  } });
  const page = createEmbedManagerChannelPager(guild);
  page(records, 0);
  const initialReads = reads;
  const next = page(records, 1);
  assert.equal(reads, initialReads);
  assert.deepEqual(JSON.parse(JSON.stringify(next)), JSON.parse(JSON.stringify(buildChannelPayload(guild, [], 1))));
  page([], 2);
});
