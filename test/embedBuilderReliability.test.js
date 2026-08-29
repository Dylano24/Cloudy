import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { db, getFromDb, setInDb } from '../src/utils/database.js';
import {
  reconcileEmbedRegistry,
  removeEmbedRegistryMessage,
} from '../src/services/embedRegistryService.js';
import {
  buildChannelPayload,
  openEmbedManager,
} from '../src/services/embedManagerService.js';
import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

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

test('emoji editor preserves animated emoji data and applies live field updates', async () => {
  const updates = [];
  const token = createEmbedColorPickerSession({
    userId: 'owner-user',
    emojis: [{ id: '400000000000000001', name: 'cloudy_wave', animated: true }],
    getEditorState: () => ({ title: 'Hello', message: 'World', footer: 'Footer' }),
    onEditorUpdate: async (field, value) => updates.push({ field, value }),
    onColor: async () => {},
  });

  const state = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
  const statePayload = JSON.parse(state.color);
  assert.deepEqual(statePayload.emojis, [
    { id: '400000000000000001', name: 'cloudy_wave', animated: true },
  ]);

  const markup = '<a:cloudy_wave:400000000000000001>';
  const update = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'message', value: `Hi ${markup}` })}`,
  );

  assert.equal(update.ok, true);
  assert.deepEqual(updates, [{ field: 'message', value: `Hi ${markup}` }]);
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
