import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { db, getTicketData } from '../src/utils/database.js';
import { createTicket } from '../src/services/ticket.js';

test('ticket creation returns before the staff log is delivered, and the log is still sent once', async () => {
  const guildId = '1730000000000000001';
  const values = new Map([[`guild:${guildId}:config`, {
    ticketStaffRoleId: '1730000000000000002', ticketLogsChannelId: '1730000000000000003', logging: { enabled: false },
  }]]);
  const storage = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
  };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;

  let releaseLog;
  const logs = [];
  const client = { user: { id: '1730000000000000009' }, db: storage, users: { fetch: async () => null } };
  const guild = { id: guildId, name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async () => null },
    roles: { cache: new Collection() },
    channels: { cache: new Collection(), create: async options => {
      const channel = { id: '1730000000000000004', name: options.name, guild, client,
        send: async payload => ({ id: payload.content ? 'ping' : 'main-ticket', ...payload }) };
      guild.channels.cache.set(channel.id, channel);
      return channel;
    } } };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  guild.channels.cache.set('1730000000000000003', { id: '1730000000000000003', type: ChannelType.GuildText,
    isSendable: () => true, permissionsFor: () => ({ has: () => true }),
    send: async payload => { await new Promise(resolve => { releaseLog = resolve; }); logs.push(payload); return { id: 'log' }; } });
  const member = { id: '1730000000000000005', toString: () => '<@1730000000000000005>' };

  const result = await createTicket(guild, member, null, 'Need help', 'none', {
    config: values.get(`guild:${guildId}:config`), skipLimitCheck: true });

  assert.equal(result.ticketMessage.id, 'main-ticket');
  assert.equal((await getTicketData(guildId, result.channel.id)).ticketMessageId, 'main-ticket');
  assert.equal(logs.length, 0, 'creation must not wait for the log channel');
  for (let i = 0; i < 50 && !releaseLog; i += 1) await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(typeof releaseLog, 'function', 'the open log must still be sent');
  releaseLog();
  for (let i = 0; i < 10 && !logs.length; i += 1) await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].embeds[0].toJSON().title, 'Ticket created');
});
