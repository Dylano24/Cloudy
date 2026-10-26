import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  peekEmbedRegistry,
  registerCloudyEmbedMessage,
  purgeEmbedRegistryRecord,
} from '../src/services/embedRegistryService.js';

test('repeated Save updates the same posted embed, never a second registry/log identity', async t => {
  const guildId = 'builder-save-one-post-20261026';
  const channelId = '1588888888888888801';
  const messageId = '1588888888888888802';
  const registryKey = 'cloudy:embed-registry:' + guildId;
  const data = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(data.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { data.set(key, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async key => { data.delete(key); return true; });

  const message = (id, title, description) => ({
    id, guildId, channelId, content: '',
    client: { user: { id: 'bot' } },
    author: { id: 'bot' },
    embeds: [{ title, description, color: 0xFFFFFF }],
    components: [],
  });

  const initial = message(messageId, 'Test 1', 'Original body');
  const updated = message(messageId, 'Test 2', 'Edited body');
  assert.equal(await registerCloudyEmbedMessage(initial, 'embed-builder', { manualSave: true }), true);
  assert.equal(await registerCloudyEmbedMessage(updated, 'embed-builder', { manualSave: true }), true);
  assert.equal(await registerCloudyEmbedMessage(updated, 'embed-builder', { manualSave: true }), true);

  let records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1, 'repeated saves must reuse one physical message record');
  assert.equal(records[0].messageId, messageId);
  assert.equal(records[0].snapshot.title, 'Test 2');
  assert.equal(records[0].snapshot.description, 'Edited body');

  // The gateway may deliver an older message snapshot after explicit Save.
  assert.equal(await registerCloudyEmbedMessage(initial, 'bot-history'), true);
  records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot.title, 'Test 2', 'a late old title must not replace a confirmed Save');
  assert.equal(records[0].snapshot.description, 'Edited body');
  assert.equal(peekEmbedRegistry(guildId).length, 1);

  // Delete removes exactly this user-authored message, not unrelated logs.
  assert.equal(await purgeEmbedRegistryRecord(guildId, channelId, messageId, null), true);
  assert.deepEqual(data.get(registryKey), []);

  // Late create/update events must not resurrect the deleted title in Search.
  assert.equal(await registerCloudyEmbedMessage(initial, 'bot-history'), true);
  assert.equal(await registerCloudyEmbedMessage(updated, 'embed-builder', { manualSave: true }), true);
  assert.deepEqual(await getEmbedRegistry(guildId), []);

  const another = message('1588888888888888803', 'Independent log', 'Should remain');
  assert.equal(await registerCloudyEmbedMessage(another, 'embed-builder', { manualSave: true }), true);
  assert.deepEqual((await getEmbedRegistry(guildId)).map(item => item.messageId), [another.id]);
});
