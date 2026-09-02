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
  removeEmbedRegistryMessage,
} from '../src/services/embedRegistryService.js';
import {
  buildEmbedPayload,
  buildChannelPayload,
  openEmbedManager,
  shouldApplyBackgroundRegistryRefresh,
  templateIdentity,
} from '../src/services/embedManagerService.js';
import {
  CLOUDY_LOGO_URL,
  isCloudyLogoUrl,
  migrateCloudyLogoEmbedData,
} from '../src/services/cloudyLogoService.js';
import { getSystemEmbedTemplateKey } from '../src/services/systemEmbedCatalogService.js';
import {
  isBlackjackEmbed,
  stripBlackjackCardsRemaining,
} from '../src/utils/blackjackEmbedPresentation.js';
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
    // These fixtures model a custom Builder message. The registry deliberately
    // excludes random ordinary bot responses from the editable list.
    source: 'embed-builder',
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

test('renaming a catalog embed keeps its stable game template identity', () => {
  const savedCatalogEmbed = {
    title: 'My custom Blackjack title',
    author: {
      name: 'Cloudy template key: game:blackjack:bet || Cloudy context: gambling/blackjack || Cloudy kind: embed',
    },
  };

  assert.equal(
    templateIdentity('200000000000000001', savedCatalogEmbed),
    'game:blackjack:bet',
  );
});

test('the old GitHub-hosted C logo is recognized and migrated to the stable CDN URL', () => {
  const oldLogoUrl = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
  const migrated = migrateCloudyLogoEmbedData({ thumbnail: { url: oldLogoUrl } });

  assert.equal(isCloudyLogoUrl(oldLogoUrl), true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.data.thumbnail.url, CLOUDY_LOGO_URL);
  assert.match(CLOUDY_LOGO_URL, /^https:\/\/cdn\.jsdelivr\.net\//);
});

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

test('emoji editor preserves animated emoji data and keeps only the latest live field update', async () => {
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
  const latestUpdate = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'message', value: `Latest ${markup}` })}`,
  );

  assert.equal(update.ok, true);
  assert.equal(latestUpdate.ok, true);
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.deepEqual(updates, [{ field: 'message', value: `Latest ${markup}` }]);

  const fieldUpdate = await applyEmbedColorPickerSession(
    token,
    `__CLOUDY_EMBED_EDIT__:${JSON.stringify({ field: 'embed_field_value:0', value: `Updated ${markup}` })}`,
  );
  assert.equal(fieldUpdate.ok, true);
  await new Promise(resolve => { setTimeout(resolve, 10); });
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

test('casino template identities ignore dynamic bets but keep result states separate', () => {
  const blackjackBet = getSystemEmbedTemplateKey(
    'embed',
    'Blackjack — Bet $10',
    '',
    'gambling/blackjack',
  );
  const blackjackBetLater = getSystemEmbedTemplateKey(
    'embed',
    'Blackjack — Bet $100',
    '',
    'gambling/blackjack',
  );

  assert.equal(blackjackBet, 'game:blackjack:bet');
  assert.equal(blackjackBetLater, blackjackBet);
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Result: Loss', 'Payout: **$0**', 'gambling/blackjack'),
    'game:blackjack:result:loss',
  );
  assert.equal(
    getSystemEmbedTemplateKey('embed', 'Result: Win', 'Payout: **$20**', 'gambling/blackjack'),
    'game:blackjack:result:win',
  );
});

test('legacy Blackjack styling cannot restore Cards Remaining', () => {
  const result = stripBlackjackCardsRemaining({
    title: 'Result: Win',
    description: 'Payout: **$20**\nCash balance: **$120**\n\nCards remaining: **42**',
    fields: [
      { name: 'Your Hand', value: '20' },
      { name: 'Dealer Hand', value: '18' },
    ],
  });

  assert.equal(isBlackjackEmbed(result), true);
  assert.equal(result.description, 'Payout: **$20**\nCash balance: **$120**');
});

test('embed manager shows one editable casino template for repeated dynamic results', () => {
  const guildId = '100000000000000011';
  const channelId = '200000000000000011';
  const guild = buildGuild({ guildId, channelId, messages: new Map() });
  guild.channels.cache.get(channelId).name = 'gambling';

  const catalogRecord = (messageId, title, createdAt) => ({
    guildId,
    channelId,
    backingChannelId: '900000000000000011',
    messageId,
    embedIndex: 0,
    source: 'system-catalog',
    title,
    name: title,
    createdAt,
  });

  const payload = buildEmbedPayload(guild, [
    catalogRecord('300000000000000021', 'Blackjack — Bet $10', '2026-09-01T20:00:00.000Z'),
    catalogRecord('300000000000000022', 'Blackjack — Bet $100', '2026-09-01T20:01:00.000Z'),
    catalogRecord('300000000000000023', 'Result: Loss', '2026-09-01T20:02:00.000Z'),
    catalogRecord('300000000000000024', 'Result: Loss', '2026-09-01T20:03:00.000Z'),
  ], channelId);

  const options = payload.components[0].toJSON().components[0].options;
  assert.equal(options.length, 2);
  assert.ok(options.some(option => option.label === 'Blackjack — Bet'));
  assert.ok(options.some(option => option.label === 'Result: Loss'));
  assert.ok(options.some(option => /applies to 2 matching embed\(s\)/.test(option.description)));
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
