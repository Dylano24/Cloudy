import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EmbedBuilder } from 'discord.js';

import { db, getFromDb, setInDb } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  isRegistrableCloudyEmbedMessage,
  reconcileEmbedRegistry,
  registerCloudyEmbedMessage,
  replaceSystemCatalogRegistryRowsForMessage,
  removeEmbedRegistryMessage,
  scanGuildForCloudyEmbeds,
} from '../src/services/embedRegistryService.js';
import {
  buildChannelPayload,
  openEmbedManager,
  shouldApplyBackgroundRegistryRefresh,
} from '../src/services/embedManagerService.js';
import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';
import {
  applySavedEmbedTemplates,
  decorateEmbedWithSavedTemplate,
  saveEmbedTemplateDecoration,
} from '../src/services/embedTemplateService.js';
import { fetchRecentAuditEntry } from '../src/services/recentAuditLogService.js';

function installTestStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return values;
}

function record(guildId, channelId, messageId, embedIndex, title) {
  return {
    guildId,
    channelId,
    messageId,
    embedIndex,
    source: 'test',
    title,
    name: title,
    createdAt: '2026-08-29T20:00:00.000Z',
  };
}

function missingMessageError() {
  const error = new Error('Unknown Message');
  error.code = 10008;
  return error;
}

function buildGuild({ guildId, channelId, messages }) {
  const channel = {
    id: channelId,
    name: 'command-channel',
    rawPosition: 1,
    position: 1,
    parent: null,
    toString: () => `<#${channelId}>`,
    messages: {
      fetch: async messageId => {
        if (!messages.has(messageId)) throw missingMessageError();
        return messages.get(messageId);
      },
    },
  };
  const client = { user: { id: 'cloudy-bot' } };
  return {
    id: guildId,
    client,
    members: { me: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async id => id === channelId ? channel : null,
    },
  };
}

test('registry reconciliation removes deleted messages and missing embed indexes from counts', async () => {
  installTestStorage();
  const guildId = '100000000000000001';
  const channelId = '200000000000000001';
  const liveMessageId = '300000000000000001';
  const deletedMessageId = '300000000000000002';
  const registryKey = `cloudy:embed-registry:${guildId}`;

  await setInDb(registryKey, [
    record(guildId, channelId, liveMessageId, 0, 'Live embed'),
    record(guildId, channelId, liveMessageId, 1, 'Removed second embed'),
    record(guildId, channelId, deletedMessageId, 0, 'Deleted message'),
  ]);

  const messages = new Map([[
    liveMessageId,
    {
      id: liveMessageId,
      guildId,
      channelId,
      author: { id: 'cloudy-bot' },
      embeds: [{ title: 'Live embed', description: 'Still exists' }],
      createdAt: new Date('2026-08-29T20:00:00.000Z'),
    },
  ]]);
  const guild = buildGuild({ guildId, channelId, messages });

  const result = await reconcileEmbedRegistry(guild);
  const payload = buildChannelPayload(guild, result.records);

  assert.equal(result.records.length, 1);
  assert.equal(result.removedRecords, 2);
  assert.match(payload.embeds[0].toJSON().description, /\*\*Embeds found:\*\* 1/);
  assert.match(payload.components[0].toJSON().components[0].options[0].label, /1 embed$/);
  assert.equal((await getFromDb(registryKey, [])).length, 1);
});

test('message deletion removes every embed index for that message', async () => {
  installTestStorage();
  const guildId = '100000000000000002';
  const channelId = '200000000000000002';
  const messageId = '300000000000000003';
  const otherMessageId = '300000000000000004';
  const registryKey = `cloudy:embed-registry:${guildId}`;

  await setInDb(registryKey, [
    record(guildId, channelId, messageId, 0, 'First'),
    record(guildId, channelId, messageId, 1, 'Second'),
    record(guildId, channelId, otherMessageId, 0, 'Keep'),
  ]);

  await removeEmbedRegistryMessage(guildId, channelId, messageId);
  const remaining = await getFromDb(registryKey, []);

  assert.deepEqual(remaining.map(item => item.messageId), [otherMessageId]);
});

test('catalog registration atomically replaces stale and legacy rows with stable identities', async () => {
  installTestStorage();
  const guildId = '100000000000000011';
  const featureChannelId = '200000000000000011';
  const catalogChannelId = '200000000000000012';
  const catalogMessageId = '300000000000000011';
  const liveMessageId = '300000000000000012';
  const registryKey = `cloudy:embed-registry:${guildId}`;
  const metadata = key => ({
    name: `Cloudy template key: ${key} || Cloudy context: gambling/blackjack || Cloudy kind: embed`,
  });

  await setInDb(registryKey, [
    {
      ...record(guildId, featureChannelId, catalogMessageId, 7, 'Legacy catalog row'),
      source: 'system-catalog',
    },
    {
      ...record(guildId, featureChannelId, catalogMessageId, 1, 'Stale catalog row'),
      backingChannelId: catalogChannelId,
      source: 'system-catalog',
      catalogTemplateIdentity: 'gambling/blackjack:embed:stale',
    },
    record(guildId, featureChannelId, liveMessageId, 0, 'Keep live embed'),
  ]);

  const liveMessage = {
    id: liveMessageId,
    guildId,
    channelId: featureChannelId,
    author: { id: 'cloudy-bot' },
    content: '',
    flags: { has: () => false },
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
    embeds: [{ title: 'Keep live embed' }],
  };
  const featureChannel = {
    id: featureChannelId,
    name: 'gambling',
    position: 1,
    parent: null,
    isTextBased: () => true,
    messages: { fetch: async id => id === liveMessageId ? liveMessage : null },
  };
  const catalogChannel = {
    id: catalogChannelId,
    name: 'botlog',
    position: 2,
    parent: null,
    isTextBased: () => true,
    messages: { fetch: async id => catalogMessages.get(id) || null },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy-bot' } },
    members: { me: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([
        [featureChannelId, featureChannel],
        [catalogChannelId, catalogChannel],
      ]),
      fetch: async id => id === catalogChannelId ? catalogChannel : featureChannel,
    },
  };
  const catalogMessage = {
    id: catalogMessageId,
    guildId,
    channelId: catalogChannelId,
    guild,
    author: { id: 'cloudy-bot' },
    content: 'System & error embed templates',
    flags: { has: () => false },
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
    embeds: [
      { title: 'Template A', author: metadata('template-a') },
      { title: 'Template B', author: metadata('template-b') },
    ],
  };
  const catalogMessages = new Map([[catalogMessageId, catalogMessage]]);

  assert.equal(await replaceSystemCatalogRegistryRowsForMessage(catalogMessage), true);
  let records = await getEmbedRegistry(guildId);
  assert.equal(records.filter(item => item.messageId === catalogMessageId).length, 2);
  assert.ok(records.some(item => item.messageId === liveMessageId));
  assert.deepEqual(
    records
      .filter(item => item.messageId === catalogMessageId)
      .map(item => item.catalogTemplateIdentity)
      .sort(),
    [
      'gambling/blackjack:embed:template-a',
      'gambling/blackjack:embed:template-b',
    ],
  );

  const reducedCatalogMessage = {
    ...catalogMessage,
    embeds: [{ title: 'Template B renamed', author: metadata('template-b') }],
  };
  catalogMessages.set(catalogMessageId, reducedCatalogMessage);
  assert.equal(await replaceSystemCatalogRegistryRowsForMessage(reducedCatalogMessage), true);
  records = await getEmbedRegistry(guildId);
  assert.equal(records.filter(item => item.messageId === catalogMessageId).length, 1);
  assert.equal(records.find(item => item.messageId === catalogMessageId).embedIndex, 0);
  assert.equal(
    records.find(item => item.messageId === catalogMessageId).catalogTemplateIdentity,
    'gambling/blackjack:embed:template-b',
  );

  const before = buildChannelPayload(guild, records).embeds[0].toJSON().description;
  const reconciled = await reconcileEmbedRegistry(guild);
  const after = buildChannelPayload(guild, reconciled.records).embeds[0].toJSON().description;
  assert.match(before, /\*\*Embeds found:\*\* 1/);
  assert.match(before, /\*\*Cloudy templates:\*\* 1/);
  assert.equal(after, before);
});

test('history scan also replaces stale catalog rows without waiting for reconciliation', async () => {
  installTestStorage();
  const guildId = '100000000000000013';
  const catalogChannelId = '200000000000000013';
  const catalogMessageId = '300000000000000013';
  const registryKey = `cloudy:embed-registry:${guildId}`;
  await setInDb(registryKey, [
    {
      ...record(guildId, catalogChannelId, catalogMessageId, 0, 'Current slot'),
      source: 'system-catalog',
    },
    {
      ...record(guildId, 'legacy-virtual-channel', catalogMessageId, 4, 'Stale legacy slot'),
      source: 'system-catalog',
    },
  ]);

  const catalogMessage = {
    id: catalogMessageId,
    guildId,
    channelId: catalogChannelId,
    author: { id: 'cloudy-bot' },
    content: 'System & error embed templates',
    flags: { has: () => false },
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
    embeds: [{
      title: 'Current slot renamed',
      author: {
        name: 'Cloudy template key: current-slot || Cloudy context: botlog/shared || Cloudy kind: embed',
      },
    }],
  };
  const batch = new Map([[catalogMessageId, catalogMessage]]);
  batch.last = () => [...batch.values()].at(-1);
  const channel = {
    id: catalogChannelId,
    name: 'botlog',
    type: 0,
    position: 1,
    parent: null,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async options => typeof options === 'object' ? batch : catalogMessage,
    },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy-bot' } },
    members: { me: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[catalogChannelId, channel]]),
      fetch: async () => channel,
    },
  };
  catalogMessage.guild = guild;

  const scan = await scanGuildForCloudyEmbeds(guild, 'cloudy-bot', { maxMessagesPerChannel: 100 });
  const records = await getEmbedRegistry(guildId);
  assert.equal(scan.found, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, catalogMessageId);
  assert.equal(records[0].embedIndex, 0);
  assert.equal(records[0].catalogTemplateIdentity, 'botlog/shared:embed:current-slot');

  const emptyCatalogMessage = { ...catalogMessage, embeds: [] };
  batch.set(catalogMessageId, emptyCatalogMessage);
  const emptyScan = await scanGuildForCloudyEmbeds(guild, 'cloudy-bot', { maxMessagesPerChannel: 100 });
  assert.equal(emptyScan.found, 0);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('private builder previews and command replies never enter the editable embed registry', async () => {
  installTestStorage();
  const guildId = '100000000000000009';
  const channelId = '200000000000000009';
  const base = {
    id: '300000000000000009',
    guildId,
    channelId,
    embeds: [{ title: 'User preview' }],
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
  };

  const ephemeralPreview = {
    ...base,
    flags: { has: flag => flag === 64 },
  };
  const publicCommandReply = {
    ...base,
    id: '300000000000000010',
    flags: { has: () => false },
    interactionMetadata: { id: '400000000000000009' },
  };

  assert.equal(isRegistrableCloudyEmbedMessage(ephemeralPreview), false);
  assert.equal(isRegistrableCloudyEmbedMessage(publicCommandReply), false);
  assert.equal(await registerCloudyEmbedMessage(ephemeralPreview, 'automatic'), false);
  assert.equal(await registerCloudyEmbedMessage(publicCommandReply, 'automatic'), false);
  assert.deepEqual(await getEmbedRegistry(guildId), []);
});

test('emoji editor preserves animated emoji data and applies live field updates', async () => {
  const updates = [];
  const token = createEmbedColorPickerSession({
    userId: 'owner-user',
    emojis: [{ id: '400000000000000001', name: 'cloudy_wave', animated: true }],
    getEditorState: () => ({
      title: 'Hello',
      message: 'World',
      footer: 'Footer',
      fields: [{ name: 'Rule', value: 'Be respectful', inline: false }],
    }),
    onEditorUpdate: async (field, value) => updates.push({ field, value }),
    onColor: async () => {},
  });

  const state = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
  const statePayload = JSON.parse(state.color);
  assert.deepEqual(statePayload.emojis, [
    { id: '400000000000000001', name: 'cloudy_wave', animated: true },
  ]);
  assert.deepEqual(statePayload.fields, [
    { name: 'Rule', value: 'Be respectful', inline: false },
  ]);

  const markup = '<a:cloudy_wave:400000000000000001>';
  const update = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'message', value: `Hi ${markup}` })}`,
  );

  assert.equal(update.ok, true);
  assert.deepEqual(updates, [{ field: 'message', value: `Hi ${markup}` }]);

  const fieldUpdate = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'embed_field_value:0', value: `Updated ${markup}` })}`,
  );
  assert.equal(fieldUpdate.ok, true);
  assert.deepEqual(updates.at(-1), { field: 'embed_field_value:0', value: `Updated ${markup}` });
  deleteEmbedColorPickerSession(token);
  assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__')).reason, 'expired');
});

class FakeCollector extends EventEmitter {
  ended = false;

  stop(reason) {
    if (this.ended) return;
    this.ended = true;
    this.emit('end', [], reason);
  }
}

test('background registry refresh stops as soon as manager interaction begins', () => {
  const session = { closed: false, hasInteracted: false };
  const state = { activeEmbedManager: session };

  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), true);

  session.hasInteracted = true;
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);

  session.hasInteracted = false;
  session.closed = true;
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);

  session.closed = false;
  state.activeEmbedManager = {};
  assert.equal(shouldApplyBackgroundRegistryRefresh(state, session), false);
});

test('embed manager navigation edits through the fresh component interaction', async () => {
  installTestStorage();
  const guildId = '100000000000000003';
  const channelId = '200000000000000003';
  const messageId = '300000000000000005';
  await setInDb(`cloudy:embed-registry:${guildId}`, [
    record(guildId, channelId, messageId, 0, 'Editable embed'),
  ]);

  const messages = new Map([[
    messageId,
    {
      id: messageId,
      guildId,
      channelId,
      author: { id: 'cloudy-bot' },
      embeds: [{ title: 'Editable embed', description: 'Content' }],
      createdAt: new Date('2026-08-29T20:00:00.000Z'),
    },
  ]]);
  const guild = buildGuild({ guildId, channelId, messages });
  const collector = new FakeCollector();
  const managerMessage = {
    id: 'manager-message',
    createMessageComponentCollector: () => collector,
  };
  let initialPayload = null;
  const buttonInteraction = {
    guild,
    client: guild.client,
    user: { id: 'owner-user' },
    deferUpdate: async () => {},
    followUp: async payload => {
      initialPayload = payload;
      return managerMessage;
    },
    webhook: {
      deleteMessage: async () => {},
    },
  };
  const state = {};

  await openEmbedManager(buttonInteraction, state, async () => true);
  assert.match(initialPayload.embeds[0].toJSON().description, /Choose a channel first/);
  assert.equal(initialPayload.components.length, 1);
  assert.ok(state.activeEmbedManager);

  let navigationPayload = null;
  let navigationFinished;
  const finished = new Promise(resolve => {
    navigationFinished = resolve;
  });
  collector.emit('collect', {
    user: { id: 'owner-user' },
    customId: 'simple_embed_modify_channel:0',
    values: [channelId],
    deferred: false,
    replied: false,
    isStringSelectMenu: () => true,
    deferUpdate: async function deferUpdate() {
      this.deferred = true;
    },
    editReply: async payload => {
      navigationPayload = payload;
      navigationFinished();
    },
  });

  await finished;
  assert.match(navigationPayload.embeds[0].toJSON().description, /\*\*Embeds:\*\* 1/);
  collector.stop('test-complete');
});

test('embed manager opens before Discord history reconciliation finishes', async () => {
  installTestStorage();
  const guildId = '100000000000000004';
  const channelId = '200000000000000004';
  const messageId = '300000000000000006';
  await setInDb(`cloudy:embed-registry:${guildId}`, [
    record(guildId, channelId, messageId, 0, 'Immediate embed'),
  ]);

  let finishFetch;
  const pendingFetch = new Promise(resolve => {
    finishFetch = resolve;
  });
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).messages.fetch = async () => pendingFetch;

  const collector = new FakeCollector();
  const managerMessage = {
    id: 'immediate-manager-message',
    createMessageComponentCollector: () => collector,
  };
  let initialPayload = null;
  const buttonInteraction = {
    guild,
    client: guild.client,
    user: { id: 'owner-user' },
    deferUpdate: async () => {},
    followUp: async payload => {
      initialPayload = payload;
      return managerMessage;
    },
    webhook: {
      deleteMessage: async () => {},
      editMessage: async () => {},
    },
  };
  const state = {};

  await openEmbedManager(buttonInteraction, state, async () => true);
  assert.match(initialPayload.embeds[0].toJSON().description, /Choose a channel first/);
  assert.ok(state.activeEmbedManager);

  finishFetch({
    id: messageId,
    guildId,
    channelId,
    author: { id: 'cloudy-bot' },
    embeds: [{ title: 'Immediate embed' }],
    createdAt: new Date('2026-08-29T20:00:00.000Z'),
  });
  collector.stop('test-complete');
});

test('saved template is applied before send and does not cause a second edit', async () => {
  installTestStorage();
  const guildId = '100000000000000005';
  const channelId = '200000000000000005';
  const dynamicThumbnail = 'https://cdn.discordapp.com/avatars/dynamic.png';

  await saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Ban log'],
    {
      title: 'Ban log',
      color: 0x123456,
      footer: { text: 'Saved footer' },
    },
  );

  const source = new EmbedBuilder()
    .setTitle('Ban log')
    .setDescription('**User:** Dynamic user')
    .setColor(0xED4245)
    .setThumbnail(dynamicThumbnail)
    .setTimestamp();
  const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, source);

  assert.equal(decorated.matched, true);
  assert.equal(decorated.changed, true);
  assert.equal(decorated.embed.toJSON().color, 0x123456);
  assert.equal(decorated.embed.toJSON().footer.text, 'Saved footer');
  assert.equal(decorated.embed.toJSON().description, '**User:** Dynamic user');
  assert.equal(decorated.embed.toJSON().thumbnail.url, dynamicThumbnail);

  let editCount = 0;
  const alreadyDecoratedMessage = {
    guildId,
    channelId,
    editable: true,
    embeds: [decorated.embed],
    edit: async () => {
      editCount += 1;
    },
  };
  assert.equal(await applySavedEmbedTemplates(alreadyDecoratedMessage), true);
  assert.equal(editCount, 0);
});

test('audit log lookup returns immediately when Discord already has the entry', async () => {
  const expected = {
    target: { id: 'target-user' },
    createdTimestamp: Date.now(),
  };
  let fetchCount = 0;
  const guild = {
    fetchAuditLogs: async () => {
      fetchCount += 1;
      return { entries: { find: predicate => predicate(expected) ? expected : null } };
    },
  };

  const result = await fetchRecentAuditEntry(guild, 20, 'target-user');
  assert.equal(result, expected);
  assert.equal(fetchCount, 1);
});
