import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { db, getTicketKey } from '../src/utils/database.js';
import { stabilizeCreatedTicket } from '../src/services/ticketReliabilityService.js';

const flush = () => new Promise(resolve => { setImmediate(resolve); });

test('a new ticket is ready for the creator before its main-message paint finishes; the paint still happens', async () => {
  const guildId = '1632882647838299901';
  const channelId = '1654538622672599901';
  const ticketData = {
    id: channelId, userId: '1634506224312389802', guildId, status: 'open', priority: 'none',
    reason: 'Need help', ticketNumber: '7', ticketMessageId: 'main-7', pinned: false,
  };
  const values = new Map([[getTicketKey(guildId, channelId), structuredClone(ticketData)]]);
  const storage = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
  };
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = storage;

  const client = { user: { id: 'bot' }, db: { ...storage, isAvailable: () => true } };
  const guild = { id: guildId, client, channels: { cache: new Collection() }, roles: { cache: new Collection() } };
  let releaseEdit;
  const paints = [];
  const main = {
    id: 'main-7', author: client.user, editable: true, flags: { has: () => false },
    embeds: [{ title: 'Ticket #7' }], components: [],
    edit: async payload => {
      await new Promise(resolve => { releaseEdit = resolve; });
      paints.push(JSON.parse(JSON.stringify(payload)));
      return main;
    },
  };
  const channel = { id: channelId, guild, client, name: 'ticket-7', setName: async name => { channel.name = name; return channel; },
    messages: { fetch: async () => main } };
  guild.channels.cache.set(channelId, channel);

  const result = await stabilizeCreatedTicket(channel, structuredClone(ticketData), main);
  assert.equal(result.channel, channel, 'creation completes while the Discord edit is still pending');
  assert.equal(paints.length, 0);

  for (let i = 0; i < 50 && !releaseEdit; i += 1) await flush();
  assert.ok(releaseEdit, 'the main-message paint was started');
  releaseEdit();
  for (let i = 0; i < 50 && !paints.length; i += 1) await flush();
  assert.equal(paints.length, 1);
  assert.equal(paints[0].embeds[0].title, 'Ticket #7');
  assert.deepEqual(paints[0].components[0].components.map(button => button.custom_id), ['ticket_claim', 'ticket_pin', 'ticket_close']);
  guild.channels.cache.delete(channelId);
});
