import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchDenseRegistryMessages } from '../src/services/embedRegistryService.js';

function targets(count, channelId = '123456789012345678') {
  return Array.from({ length: count }, (_, i) => {
    const messageId = String(123456789012345678n + BigInt(i));
    return [channelId + ':' + messageId, [{ channelId, messageId, source: 'bot-history' }]];
  });
}

test('dense registry reconciliation can load many records in one Discord request', async () => {
  const records = targets(24);
  const messages = records.map(([key, rows]) => ({
    id: rows[0].messageId,
    channelId: rows[0].channelId,
    key,
  }));
  const requested = [];
  const channel = { messages: { fetch: async opts => {
    requested.push(opts);
    return new Map(messages.map(msg => [msg.id, msg]));
  } } };
  const guild = { channels: { cache: new Map([['123456789012345678', channel]]) } };
  const found = await prefetchDenseRegistryMessages(guild, records);

  assert.equal(found.size, 24);
  assert.equal(requested.length, 1, 'one around request replaces 24 individual reads');
  assert.deepEqual(requested[0], { limit: 100, around: records[0][1][0].messageId });
  assert.deepEqual(found.get(records[15][0]), messages[15]);
});

test('sparse or inaccessible channels fall back to existing individual reads', async () => {
  let requests = 0;
  const records = targets(15);
  const [firstKey, firstRows] = records[0];
  const channel = { messages: { fetch: async () => {
    requests += 1;
    const msg = { id: firstRows[0].messageId, channelId: firstRows[0].channelId };
    return new Map([[msg.id, msg]]);
  } } };
  const guild = { channels: { cache: new Map([['123456789012345678', channel]]) } };
  const found = await prefetchDenseRegistryMessages(guild, records);
  assert.equal(requests, 1, 'stop speculative broad reads when targets are sparse');
  assert.equal(found.size, 1);
  assert.equal(found.get(firstKey).id, firstRows[0].messageId);

  channel.messages.fetch = async () => { throw new Error('missing permissions'); };
  assert.equal((await prefetchDenseRegistryMessages(guild, records)).size, 0);

  assert.equal((await prefetchDenseRegistryMessages(guild, targets(11))).size, 0);
});

test('one channel cannot supply records from another channel or a different message id', async () => {
  const records = targets(13);
  const channel = { messages: { fetch: async () => {
    const forged = { id: records[0][1][0].messageId, channelId: '999999999999999999' };
    return new Map([[forged.id, forged]]);
  } } };
  const guild = { channels: { cache: new Map([['123456789012345678', channel]]) } };
  const found = await prefetchDenseRegistryMessages(guild, records);
  assert.equal(found.size, 0, 'do not trust a mismatched source channel');
});
