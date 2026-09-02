import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbedPayload, templateIdentity } from '../src/services/embedManagerService.js';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';

function record({ id, title, fields = [], source = 'system-catalog', author = null }) {
  return {
    guildId: 'guild-1',
    channelId: 'ticket-logs-1',
    backingChannelId: source === 'system-catalog' ? 'catalog-1' : null,
    messageId: id,
    embedIndex: 0,
    source,
    title,
    name: title,
    createdAt: new Date(Number(id.replace(/\D/g, '')) || 1).toISOString(),
    snapshot: {
      title,
      fields,
      ...(author ? { author: { name: author } } : {}),
    },
  };
}

function menuLabels(payload) {
  const row = payload.components.find(component => {
    const data = component.toJSON();
    return data.components?.some(item => item.type === 3);
  });
  if (!row) return [];
  const select = row.toJSON().components.find(item => item.type === 3);
  return (select?.options || []).map(option => option.label);
}

test('ticket-logs Builder shows only real ticket events and hides panel/debug/contact history', () => {
  const ticketLogs = {
    id: 'ticket-logs-1',
    name: '🎫│ticket-logs',
    type: 0,
    messages: { fetch: async () => null },
    toString: () => '<#ticket-logs-1>',
  };
  const guild = { channels: { cache: new Map([[ticketLogs.id, ticketLogs]]) } };

  const records = [
    record({
      id: '101',
      title: 'Ticket pinned',
      fields: [
        { name: 'Ticket', value: '#ticket-1' },
        { name: 'Pinned by', value: '<@1>' },
      ],
    }),
    record({
      id: '102',
      title: 'Ticket created',
      fields: [
        { name: 'Ticket', value: '#ticket-2' },
        { name: 'Creator', value: '<@2>' },
        { name: 'Channel', value: '<#2>' },
      ],
    }),
    // Cold-start registry row: the in-memory snapshot may not be primed yet.
    record({ id: '111', title: 'Ticket closed' }),
    record({ id: '103', title: 'Contact the staff team' }),
    record({ id: '104', title: 'Change panel message' }),
    record({ id: '105', title: 'Ticket System Debug' }),
    record({ id: '106', title: 'Ticket System Health' }),
    record({ id: '107', title: 'Ticket Panel Set Up' }),
    record({ id: '108', title: '<:cloudy_terms_icon:1540244224891424898> Terms of service' }),
    record({ id: '109', title: 'Ticket • Ticket diagnostic failed: …' }),
    record({ id: '110', title: 'Remove Task from Shared List', source: 'embed-builder' }),
  ];

  const labels = menuLabels(buildEmbedPayload(guild, records, ticketLogs.id, 0));
  assert.deepEqual(labels.sort(), ['Ticket closed', 'Ticket created', 'Ticket pinned'].sort());
});

test('Cloudy Assistant and Cloudy Support Assistant share one stable template identity', () => {
  const a = templateIdentity('faq-1', {
    title: 'Cloudy Assistant',
    author: { name: 'Cloudy template key: faq:first || Cloudy context: faq/assistant || Cloudy kind: embed' },
  });
  const b = templateIdentity('faq-1', {
    title: 'Cloudy Support Assistant',
    author: { name: 'Cloudy template key: faq:second || Cloudy context: faq/help || Cloudy kind: embed' },
  });

  assert.equal(a, 'cloudy-assistant');
  assert.equal(b, 'cloudy-assistant');
});

test('live channel discovery fetches only the newest page and carries an inline preview snapshot', async () => {
  let fetchCalls = 0;
  let beforeWasUsed = false;
  const message = {
    id: '501',
    guildId: 'guild-fast',
    author: { id: 'bot-1' },
    embeds: [{ title: 'Cloudy Assistant', description: 'Latest live preview' }],
    components: [],
    flags: { has: () => false },
    createdAt: new Date('2026-09-02T11:55:00Z'),
    createdTimestamp: Date.parse('2026-09-02T11:55:00Z'),
  };
  const batch = new Map([[message.id, message]]);
  batch.last = () => message;

  const channel = {
    id: 'channel-fast',
    messages: {
      cache: new Map(),
      fetch: async options => {
        fetchCalls += 1;
        if (options?.before) beforeWasUsed = true;
        return batch;
      },
    },
  };
  const guild = {
    id: 'guild-fast',
    channels: {
      cache: new Map([[channel.id, channel]]),
      fetch: async id => id === channel.id ? channel : null,
    },
  };

  const records = await discoverRecentChannelEmbeds(guild, channel.id, 'bot-1');
  assert.equal(fetchCalls, 1);
  assert.equal(beforeWasUsed, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].snapshot?.title, 'Cloudy Assistant');
  assert.equal(records[0].snapshot?.description, 'Latest live preview');
});
