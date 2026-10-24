import assert from 'node:assert/strict';
import test from 'node:test';
import { Embed } from 'discord.js';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessage,
  removeEmbedRegistryMessage,
} from '../src/services/embedRegistryService.js';

const values = new Map();

function resetDb() {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => {
      values.delete(key);
      return true;
    },
  };
}

function botMessage({ id, guildId, channelId = 'general', title = 'Success', description = 'Done.' }) {
  return {
    id,
    guildId,
    channelId,
    content: '',
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
    channel: { id: channelId, name: channelId },
    author: { id: 'bot' },
    client: { user: { id: 'bot' } },
    embeds: [new Embed({ title, description, color: 0x00C49D })],
    components: [],
  };
}

test('a deleted runtime reply leaves no detached registry record behind', async () => {
  resetDb();
  const guildId = 'history-cleanup-guild';
  const message = botMessage({ id: 'reply-1', guildId });

  assert.equal(await registerCloudyEmbedMessage(message, 'bot-history'), true);
  assert.equal((await getEmbedRegistry(guildId)).length, 1);

  assert.equal(await removeEmbedRegistryMessage(guildId, 'general', 'reply-1'), true);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('repeated transient replies do not grow the stored registry', async () => {
  resetDb();
  const guildId = 'history-growth-guild';
  const registryKey = `cloudy:embed-registry:${guildId}`;

  for (let index = 0; index < 25; index += 1) {
    const message = botMessage({ id: `reply-${index}`, guildId, description: `Done ${index}.` });
    await registerCloudyEmbedMessage(message, 'bot-history');
    await removeEmbedRegistryMessage(guildId, 'general', message.id);
  }

  assert.equal((values.get(registryKey) || []).length, 0);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('an explicitly saved Builder post stays as a detached saved template', async () => {
  resetDb();
  const guildId = 'history-manual-guild';
  const message = botMessage({ id: 'manual-1', guildId, title: 'Rules', description: 'Saved Builder content' });

  assert.equal(await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true }), true);
  assert.equal(await removeEmbedRegistryMessage(guildId, 'general', 'manual-1'), true);

  const [record] = await getEmbedRegistry(guildId);
  assert.equal(record.detached, true);
  assert.equal(record.source, 'embed-builder');
  assert.equal(record.snapshot.title, 'Rules');
});
