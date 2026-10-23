import assert from 'node:assert/strict';
import test from 'node:test';
import { Embed } from 'discord.js';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessage,
  relinkDetachedEmbedRegistryMessage,
  removeEmbedRegistryMessage,
  updateDetachedEmbedRegistrySnapshot,
} from '../src/services/embedRegistryService.js';
import { isEmbedManagerVisibleRecord } from '../src/services/embedManagerService.js';

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

function buttonRow(label = 'Open') {
  return {
    type: 1,
    components: [{
      type: 2,
      style: 2,
      custom_id: 'cloudy_test_button',
      label,
    }],
  };
}

function builderMessage({ id, guildId, channelId = 'general', title = 'Rules', components = [buttonRow()] }) {
  return {
    id,
    guildId,
    channelId,
    content: '',
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
    channel: { id: channelId, name: channelId },
    embeds: [new Embed({
      title,
      description: 'Saved Builder content',
      color: 0xFFFFFF,
    })],
    components,
  };
}

test('manual Builder post remains saved after Discord deletion and can relink to one reposted message', async () => {
  resetDb();
  const guildId = 'durable-repost-guild';
  const original = builderMessage({ id: 'message-old', guildId });

  assert.equal(await registerCloudyEmbedMessage(original, 'embed-builder'), true);

  let records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, 'message-old');
  assert.equal(records[0].detached, false);

  assert.equal(await removeEmbedRegistryMessage(guildId, 'general', 'message-old'), true);

  records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, 'message-old');
  assert.equal(records[0].detached, true);
  assert.equal(records[0].source, 'embed-builder');
  assert.equal(isEmbedManagerVisibleRecord(records[0]), true);
  assert.equal(records[0].snapshot.title, 'Rules');
  assert.equal(records[0].components[0].components[0].label, 'Open');

  const reposted = builderMessage({
    id: 'message-new',
    guildId,
    title: 'Rules updated',
    components: [buttonRow('Reposted button')],
  });

  assert.equal(
    await relinkDetachedEmbedRegistryMessage(guildId, records[0], reposted),
    true,
  );

  records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, 'message-new');
  assert.equal(records[0].detached, false);
  assert.equal(records[0].snapshot.title, 'Rules updated');
  assert.equal(records[0].components[0].components[0].label, 'Reposted button');
  assert.equal(records.some(record => record.messageId === 'message-old'), false);
});

test('editing a missing Builder embed keeps its saved buttons for a later repost', async () => {
  resetDb();
  const guildId = 'durable-edit-guild';
  const original = builderMessage({ id: 'message-old', guildId });

  await registerCloudyEmbedMessage(original, 'embed-builder');
  await removeEmbedRegistryMessage(guildId, 'general', 'message-old');

  let [record] = await getEmbedRegistry(guildId);
  assert.equal(record.detached, true);

  const saved = await updateDetachedEmbedRegistrySnapshot(
    guildId,
    record,
    {
      title: 'Edited while missing',
      description: 'This version must be the one that gets reposted.',
      color: 0xFFFFFF,
    },
    [buttonRow('Edited button')],
  );
  assert.equal(saved, true);

  [record] = await getEmbedRegistry(guildId);
  assert.equal(record.detached, true);
  assert.equal(record.snapshot.title, 'Edited while missing');
  assert.equal(record.components[0].components[0].label, 'Edited button');
});

test('only a detached manual Builder record is exposed as a missing editable item', () => {
  const base = {
    guildId: 'guild',
    channelId: 'general',
    messageId: 'message',
    embedIndex: 0,
    detached: true,
  };

  assert.equal(isEmbedManagerVisibleRecord({ ...base, source: 'embed-builder' }), true);
  assert.equal(isEmbedManagerVisibleRecord({ ...base, source: 'bot-history' }), false);
  assert.equal(isEmbedManagerVisibleRecord({ ...base, source: 'system-catalog' }), false);
});
