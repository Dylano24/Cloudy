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
import {
  isEmbedManagerVisibleRecord,
  loadRecordSnapshotIntoState,
  syncBuilderLogoFromLiveMessage,
} from '../src/services/embedManagerService.js';
import {
  relinkExistingEmbedReappearRule,
  restoreExistingEmbedReappearRule,
} from '../src/services/embedReappearService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { buildControls } from '../src/commands/Tools/embedbuilder.js';

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


test('missing manual Builder embeds remain searchable by their original content', async () => {
  resetDb();
  const guildId = 'durable-search-guild';
  const original = builderMessage({ id: 'message-old', guildId, title: 'Server rules' });

  await registerCloudyEmbedMessage(original, 'embed-builder');
  await removeEmbedRegistryMessage(guildId, 'general', 'message-old');
  const records = await getEmbedRegistry(guildId);

  const guild = {
    channels: {
      cache: new Map([['general', { id: 'general', name: 'general', parent: null }]]),
    },
  };
  const matches = buildMatches(guild, records, 'server rules');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, 'message-old');
  assert.equal(matches[0].record.detached, true);
});

test('Repost moves an existing Reappear rule to the new message and can restore it on rollback', async () => {
  resetDb();
  const guildId = 'durable-reappear-guild';
  const channelId = 'general';
  values.set(`cloudy:embed-reappear-index:${guildId}:${channelId}`, ['message-old']);
  values.set(`cloudy:embed-reappear:${guildId}:${channelId}:message-old`, {
    guildId,
    channelId,
    messageId: 'message-old',
    originMessageId: 'message-old',
    embedIndex: 0,
    every: 3,
    count: 2,
    embed: { title: 'Old title' },
    components: [buttonRow('Old button')],
  });

  const relinked = await relinkExistingEmbedReappearRule({
    guildId,
    channelId,
    previousMessageId: 'message-old',
    messageId: 'message-new',
    embedIndex: 0,
    embed: { title: 'New title' },
    components: [buttonRow('New button')],
  });

  assert.equal(relinked.ok, true);
  assert.equal(relinked.linked, true);
  assert.equal(relinked.previousRule.messageId, 'message-old');

  let rule = values.get(`cloudy:embed-reappear:${guildId}:${channelId}:message-old`);
  assert.equal(rule.messageId, 'message-new');
  assert.equal(rule.count, 0);
  assert.equal(rule.embed.title, 'New title');
  assert.equal(rule.components[0].components[0].label, 'New button');

  assert.equal(await restoreExistingEmbedReappearRule({
    guildId,
    channelId,
    originMessageId: relinked.originMessageId,
    rule: relinked.previousRule,
  }), true);

  rule = values.get(`cloudy:embed-reappear:${guildId}:${channelId}:message-old`);
  assert.equal(rule.messageId, 'message-old');
  assert.equal(rule.count, 2);
  assert.equal(rule.embed.title, 'Old title');
  assert.equal(rule.components[0].components[0].label, 'Old button');
});


test('a missed Discord delete is detected when the saved manual embed is opened', async () => {
  resetDb();
  const guildId = 'durable-missed-delete-guild';
  const original = builderMessage({ id: 'message-old', guildId, title: 'Missing panel' });
  await registerCloudyEmbedMessage(original, 'embed-builder');

  const [record] = await getEmbedRegistry(guildId);
  const missing = new Error('Unknown message');
  missing.code = 10008;
  const channel = {
    id: 'general',
    messages: {
      fetch: async () => {
        throw missing;
      },
    },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy' } },
    channels: {
      cache: new Map([['general', channel]]),
      fetch: async id => id === 'general' ? channel : null,
    },
  };
  const state = {};

  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  assert.equal(state.modifyTarget.detached, false);
  assert.equal(await syncBuilderLogoFromLiveMessage(guild, state), true);
  assert.equal(state.modifyTarget.detached, true);

  const [savedRecord] = await getEmbedRegistry(guildId);
  assert.equal(savedRecord.detached, true);

  const ids = buildControls(state)
    .flatMap(row => row.toJSON().components)
    .map(component => component.custom_id)
    .filter(Boolean);
  assert.equal(ids.includes('simple_embed_repost'), true);
});
