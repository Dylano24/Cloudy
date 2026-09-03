import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  isRegistrableCloudyEmbedMessage,
  registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';
import {
  buildEmbedPayload,
  saveModifiedEmbed,
} from '../src/services/embedManagerService.js';
import { decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';
import { getTicketLogTemplate } from '../src/utils/ticket/ticketLogTemplates.js';

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

function fields(...names) {
  return names.map((name, index) => ({
    name,
    value: index === 0 ? '#42' : `<@${100 + index}>`,
    inline: true,
  }));
}

const ticketLogs = [
  ['open', 'Ticket created', fields('Ticket', 'Creator', 'Channel')],
  ['close', 'Ticket closed', fields('Ticket', 'Closed by')],
  ['delete', 'Ticket deleted', fields('Ticket', 'Deleted by')],
  ['claim', 'Ticket claimed', fields('Ticket', 'Claimed by')],
  ['unclaim', 'Ticket unclaimed', fields('Ticket', 'Unclaimed by')],
  ['priority', 'Priority updated', fields('Ticket', 'Priority', 'Updated by')],
  ['pin', 'Ticket pinned', fields('Ticket', 'Pinned by')],
  ['unpin', 'Ticket unpinned', fields('Ticket', 'Unpinned by')],
  ['transcript', 'Transcript generated', fields('Ticket', 'Creator', 'Messages')],
  ['feedback', 'Feedback received', fields('Ticket', 'Rating')],
];

test('all ticket lifecycle logs are recognized structurally, while in-ticket status messages are not', () => {
  for (const [key, title, logFields] of ticketLogs) {
    assert.deepEqual(getTicketLogTemplate({ title, fields: logFields }), {
      key,
      label: title,
    });
  }

  assert.equal(getTicketLogTemplate({
    title: 'Ticket deleted',
    description: 'This ticket will be deleted shortly.',
  }), null);
  assert.equal(getTicketLogTemplate({
    title: 'Ticket claimed',
    description: 'A staff member claimed this ticket.',
  }), null);
});

test('ticket lifecycle logs enter the fixed registry without admitting title-only ticket messages', async () => {
  installTestStorage();
  const guildId = 'ticket-registry-guild';
  const channelId = 'ticket-registry-channel';
  const base = {
    guildId,
    channelId,
    flags: { has: () => false },
    createdAt: new Date('2026-09-03T12:00:00.000Z'),
  };
  const logMessage = {
    ...base,
    id: 'ticket-log-message',
    embeds: [{
      title: 'Custom delete title',
      fields: fields('Ticket', 'Deleted by'),
    }],
  };
  const statusMessage = {
    ...base,
    id: 'ticket-status-message',
    embeds: [{
      title: 'Ticket deleted',
      description: 'This ticket will be deleted shortly.',
    }],
  };

  assert.equal(isRegistrableCloudyEmbedMessage(logMessage), true);
  assert.equal(isRegistrableCloudyEmbedMessage(statusMessage), false);
  assert.equal(await registerCloudyEmbedMessage(logMessage, 'automatic'), true);

  const records = await getEmbedRegistry(guildId);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'Ticket deleted');
  assert.equal(records[0].title, 'Custom delete title');
});

test('discovery promotes ticket logs only inside the configured log destinations', async () => {
  const guildId = 'ticket-discovery-guild';
  const logChannelId = 'ticket-discovery-logs';
  const liveTicketChannelId = 'ticket-discovery-live';
  const client = {
    db: {
      get: async () => ({ ticketLogsChannelId: logChannelId }),
      isAvailable: () => true,
    },
  };

  function channel(id) {
    const message = {
      id: `${id}-message`,
      guildId,
      author: { id: 'cloudy-bot' },
      embeds: [new EmbedBuilder({
        title: 'Ticket deleted',
        fields: fields('Ticket', 'Deleted by'),
      })],
      components: [],
      flags: { has: () => false },
      createdAt: new Date('2026-09-03T12:00:00.000Z'),
      createdTimestamp: Date.parse('2026-09-03T12:00:00.000Z'),
    };
    const batch = new Map([[message.id, message]]);
    batch.last = () => message;
    return {
      id,
      name: id === logChannelId ? 'ticket-logs' : 'ticket-42',
      type: 0,
      rawPosition: 1,
      position: 1,
      parent: null,
      toString: () => `<#${id}>`,
      messages: {
        cache: new Map(),
        fetch: async () => batch,
      },
    };
  }

  const logChannel = channel(logChannelId);
  const liveChannel = channel(liveTicketChannelId);
  const guild = {
    id: guildId,
    client,
    channels: {
      cache: new Map([
        [logChannelId, logChannel],
        [liveTicketChannelId, liveChannel],
      ]),
      fetch: async id => guild.channels.cache.get(id) || null,
    },
  };

  const logRecords = await discoverRecentChannelEmbeds(guild, logChannelId, 'cloudy-bot');
  const liveRecords = await discoverRecentChannelEmbeds(guild, liveTicketChannelId, 'cloudy-bot');

  assert.equal(logRecords[0].source, 'ticket-log');
  assert.equal(liveRecords[0].source, 'embed-builder');

  const payload = buildEmbedPayload(guild, logRecords, logChannelId, 0);
  const option = payload.components[0].toJSON().components[0].options[0];
  assert.equal(option.label, 'Ticket deleted');
  assert.match(option.description, /Edit this template/);
});

test('saving a ticket-log template recolors the next delete log and preserves dynamic fields', async () => {
  installTestStorage();
  const guildId = 'ticket-save-guild';
  const channelId = 'ticket-save-channel';
  const messageId = 'ticket-save-message';
  const original = new EmbedBuilder({
    title: 'Ticket deleted',
    color: 0xED4245,
    fields: [
      { name: 'Ticket', value: '#42', inline: true },
      { name: 'Deleted by', value: '<@101>', inline: true },
    ],
    footer: { text: 'Cloudy footer' },
  });
  const message = {
    id: messageId,
    guildId,
    author: { id: 'cloudy-bot' },
    flags: { has: () => false },
    embeds: [original],
    async edit(payload) {
      this.embeds = payload.embeds;
      return this;
    },
  };
  const channel = {
    id: channelId,
    messages: { fetch: async id => id === messageId ? message : null },
  };
  const guild = {
    id: guildId,
    client: { user: { id: 'cloudy-bot' } },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async id => id === channelId ? channel : null,
    },
  };
  const state = {
    title: 'Ticket deleted',
    message: null,
    embedFields: original.toJSON().fields,
    sideColor: 0x123456,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: 'Cloudy footer',
    mediaUrl: null,
    mediaBuffer: null,
    mediaName: null,
    modifyTarget: {
      guildId,
      channelId,
      backingChannelId: channelId,
      messageId,
      embedIndex: 0,
      source: 'ticket-log',
      sourceEmbedData: original.toJSON(),
      hadBuilderMarker: false,
      templateMode: true,
      templateTitle: 'ticket-log:delete',
      cachedMessage: message,
    },
  };

  const saved = await saveModifiedEmbed(guild, state);
  assert.equal(saved.ok, true);

  const nextLog = new EmbedBuilder({
    title: 'Ticket deleted',
    color: 0xED4245,
    fields: [
      { name: 'Ticket', value: '#99', inline: true },
      { name: 'Deleted by', value: '<@202>', inline: true },
    ],
    footer: { text: 'Cloudy footer' },
  });
  const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, nextLog);
  const data = decorated.embed.toJSON();

  assert.equal(decorated.matched, true);
  assert.equal(data.color, 0x123456);
  assert.equal(data.fields[0].value, '#99');
  assert.equal(data.fields[1].value, '<@202>');
});
