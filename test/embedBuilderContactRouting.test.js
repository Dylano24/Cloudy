import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessage,
} from '../src/services/embedRegistryService.js';

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
}

function textChannel(id, name, position) {
  return {
    id,
    name,
    type: 0,
    position,
    rawPosition: position,
    parent: null,
    isTextBased: () => true,
    messages: { fetch: async () => null },
  };
}

function catalogMessage({ guild, id, embed }) {
  return {
    id,
    guildId: guild.id,
    channelId: '299999999999999999',
    guild,
    content: 'System & error embed templates',
    embeds: [embed],
    createdAt: new Date('2026-09-02T11:30:00.000Z'),
    flags: { has: () => false },
  };
}

test('contact panel templates stay in contact-us while real ticket logs stay in ticket-logs', async () => {
  installTestStorage();

  const contactUs = textChannel('200000000000000201', 'contact-us', 1);
  const ticketLogs = textChannel('200000000000000202', 'ticket-logs', 2);
  const catalog = textChannel('299999999999999999', 'system-embed-catalog', 3);
  const guild = {
    id: '100000000000000201',
    channels: {
      cache: new Map([
        [contactUs.id, contactUs],
        [ticketLogs.id, ticketLogs],
        [catalog.id, catalog],
      ]),
    },
  };

  const contactEmbed = {
    title: 'Contact the Staff team',
    description: 'Contact us here to get assistance.',
    author: {
      name: 'Cloudy template key: tickets:contact || Cloudy context: tickets/contact || Cloudy kind: embed',
    },
  };
  const transcriptEmbed = {
    title: 'Transcript generated',
    description: 'Ticket transcript created.',
    fields: [
      { name: 'Ticket', value: '#123', inline: true },
      { name: 'Creator', value: '<@1>', inline: true },
      { name: 'Messages', value: '20', inline: true },
    ],
    author: {
      name: 'Cloudy template key: tickets:transcript || Cloudy context: tickets/transcript || Cloudy kind: embed',
    },
  };

  await registerCloudyEmbedMessage(catalogMessage({
    guild,
    id: '300000000000000201',
    embed: contactEmbed,
  }));
  await registerCloudyEmbedMessage(catalogMessage({
    guild,
    id: '300000000000000202',
    embed: transcriptEmbed,
  }));

  const records = await getEmbedRegistry(guild.id);
  const contactRecord = records.find(record => record.messageId === '300000000000000201');
  const transcriptRecord = records.find(record => record.messageId === '300000000000000202');

  assert.equal(contactRecord?.channelId, contactUs.id);
  assert.equal(transcriptRecord?.channelId, ticketLogs.id);
  assert.notEqual(contactRecord?.channelId, ticketLogs.id);
});


test('a Staff team catalog template mentioning contact us is never placed in #contact-us', async () => {
  installTestStorage();
  const contactUs = textChannel('200000000000000301', 'contact-us', 1);
  const staffTeam = textChannel('200000000000000302', 'staff-team', 2);
  const botlog = textChannel('200000000000000303', 'botlog', 3);
  const catalog = textChannel('299999999999999998', 'system-embed-catalog', 4);
  const guild = { id: '100000000000000301', channels: { cache: new Map(
    [contactUs, staffTeam, botlog, catalog].map(channel => [channel.id, channel])
  ) } };
  const staffEmbed = {
    title: 'Staff team',
    description: 'If you need help, contact us using the button below.',
    author: { name: 'Cloudy template key: staff:ready || Cloudy context: botlog/staff-team-ready || Cloudy kind: embed' },
  };
  const messageId = '300000000000000301';
  await registerCloudyEmbedMessage(catalogMessage({ guild, id: messageId, embed: staffEmbed }));
  const records = await getEmbedRegistry(guild.id);
  const record = records.find(item => item.messageId === messageId);
  assert.ok(record, 'catalog staff template remains discoverable');
  assert.notEqual(record.channelId, contactUs.id, 'mentioning contact us must not hijack routing');
  assert.equal(record.channelId, botlog.id, 'staff system template stays in botlog context');
});
