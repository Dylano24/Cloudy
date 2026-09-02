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
