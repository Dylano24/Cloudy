import test from 'node:test';
import assert from 'node:assert/strict';
import * as search from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('slow live hydration falls back to the saved snapshot within its time budget', async () => {
  const record = { channelId: 'channel', messageId: 'message', snapshot: { title: 'Saved', description: 'Full saved body' } };
  const guild = { id: 'search-budget', channels: { cache: new Map([['channel', { messages: { fetch: async () => new Promise(() => {}) } }]]) } };
  assert.equal(typeof search.hydrateLiveSearchRecord, 'function');
  assert.equal(await search.hydrateLiveSearchRecord(guild, record, 5), record);
});

test('healthy hydration returns live content without mutating the saved snapshot', async () => {
  const record = { channelId: 'channel', messageId: 'message', snapshot: { title: 'Saved' } };
  const embed = { toJSON: () => ({ title: 'Live', description: 'Full live body' }) };
  const guild = { id: 'search-budget-live', channels: { cache: new Map([['channel', { messages: { fetch: async () => ({ embeds: [embed], components: [] }) } }]]) } };
  assert.equal(typeof search.hydrateLiveSearchRecord, 'function');
  const loaded = await search.hydrateLiveSearchRecord(guild, record, 5);
  assert.equal(loaded.snapshot.title, 'Live');
  assert.equal(record.snapshot.title, 'Saved');
});
