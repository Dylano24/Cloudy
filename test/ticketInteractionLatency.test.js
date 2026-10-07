import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Collection, EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { db, getTicketData, getTicketKey } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';
import { getTicketPermissionContext } from '../src/utils/ticket/ticketPermissions.js';
import { getPinnedMessages } from '../src/utils/messagePins.js';

let sequence = 0;
function fixture({ staff = false, record = true } = {}) {
  const guildId = `16328826478382${String(++sequence).padStart(5, '0')}`;
  const channelId = `16545386226724${String(sequence).padStart(5, '0')}`;
  const userId = '1634506224312389801';
  const creatorId = '1634506224312389802';
  const staffRoleId = '1634506224312389810';
  const trace = [], replies = [], publicPayloads = [];
  const values = new Map();
  const ticketKey = getTicketKey(guildId, channelId);
  const storage = {
    get: async key => { trace.push(`read:${key}`); return structuredClone(values.get(key) ?? null); },
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: '1634506224312389863' }, db: { ...storage, isAvailable: () => true } };
  const staffRole = { id: staffRoleId, name: 'Staff' };
  const member = { id: userId, user: { id: userId, username: 'Staff' }, permissions: new PermissionsBitField(),
    roles: { cache: new Collection(staff ? [[staffRoleId, staffRole]] : []) } };
  const guild = { id: guildId, name: 'Cloudy', ownerId: '1634506224312389800', client,
    roles: { cache: new Collection([[staffRoleId, staffRole]]) },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) } };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const channel = { id: channelId, guild, client, name: 'ticket-1', isTextBased: () => true,
    messages: { fetch: async () => new Collection() },
    send: async payload => { publicPayloads.push(payload); return { id: `status-${publicPayloads.length}` }; } };
  guild.channels.cache.set(channelId, channel);
  values.set(`guild:${guildId}:config`, { ticketStaffRoleId: staffRoleId, logging: { enabled: false } });
  if (record) values.set(ticketKey, { id: channelId, userId: creatorId, status: 'open', ticketNumber: 1,
    reason: 'Ticket reason', createdAt: new Date().toISOString() });
  const interaction = { id: `ticket-latency-${sequence}`, guildId, channelId, guild, channel, client,
    member, user: member.user, message: { id: 'main-ticket', embeds: [new EmbedBuilder().setTitle('Ticket #1')] },
    inGuild: () => true,
    deferUpdate: async () => { trace.push('ack'); interaction.deferred = true; },
    followUp: async payload => { trace.push('followUp'); replies.push(payload); return { id: 'private-status' }; },
    editReply: async () => { throw new Error('Must never overwrite public ticket through editReply'); },
    reply: async payload => { replies.push(payload); interaction.replied = true; } };
  return { interaction, client, guild, channel, storage, ticketKey, values, trace, replies, publicPayloads };
}

test('ticket Pin has no thinking placeholder and never deletes the public ticket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ staff: true });
  const deleted = [];
  const privateReplies = [];
  f.channel.setPosition = async () => f.channel;
  f.channel.setName = async name => { f.channel.name = name; return f.channel; };
  f.interaction.webhook = { deleteMessage: async id => deleted.push(id) };
  f.interaction.deferReply = async () => assert.fail('Pin must not display a thinking reply');
  f.interaction.editReply = async () => assert.fail('Pin must not edit the original public ticket');
  f.interaction.deleteReply = async () => assert.fail('Pin must not delete the original public ticket');
  f.interaction.followUp = async payload => {
    privateReplies.push(payload);
    return { id: 'pin-private-message' };
  };

  await buttons.find(button => button.name === 'ticket_pin').execute(f.interaction, f.client);
  assert.equal(f.trace[0], 'ack');
  assert.equal(privateReplies.length, 1);
  assert.equal(privateReplies[0].flags, MessageFlags.Ephemeral);
  assert.equal(privateReplies[0].embeds[0].title, 'Ticket pinned');
  assert.equal(f.interaction.message.embeds[0].data.title, 'Ticket #1');
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).pinned, true);

  t.mock.timers.tick(9_999);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, ['pin-private-message']);
});

test('ticket Pin staff denial is private after silent acknowledgement', async () => {
  const f = fixture({ staff: false });
  const replies = [];
  f.interaction.webhook = { deleteMessage: async () => {} };
  f.interaction.deferReply = async () => assert.fail('Pin must not show Discord thinking');
  f.interaction.editReply = async () => assert.fail('Denied Pin must not edit the public ticket');
  f.interaction.followUp = async payload => {
    replies.push(payload);
    return { id: 'denied-private' };
  };
  await buttons.find(button => button.name === 'ticket_pin').execute(f.interaction, f.client);
  assert.equal(f.trace[0], 'ack');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(replies[0].embeds[0].data.title, 'Permission denied');
  assert.equal(f.interaction.message.embeds[0].data.title, 'Ticket #1');
});

test('ticket mutation buttons acknowledge before a slow permission database lookup', async () => {
  for (const name of ['ticket_claim', 'ticket_unclaim', 'ticket_reopen', 'ticket_delete']) {
    const f = fixture({ record: false });
    let finishLookup;
    const originalGet = f.storage.get;
    f.storage.get = key => key === f.ticketKey
      ? new Promise(resolve => { f.trace.push('slow-ticket-read'); finishLookup = resolve; })
      : originalGet(key);
    const action = buttons.find(button => button.name === name).execute(f.interaction, f.client);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(f.trace[0], 'ack');
    assert.equal(typeof finishLookup, 'function');
    assert.equal(f.replies.length, 0);
    finishLookup(null);
    await action;
    assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(f.replies[0].embeds[0].data.description, /valid ticket channel/);
    assert.equal(f.publicPayloads.length, 0);
    assert.equal(f.interaction.message.embeds[0].data.title, 'Ticket #1');
  }
});

test('unauthorized ticket mutation buttons preserve state and deliver permission denial privately', async () => {
  for (const name of ['ticket_claim', 'ticket_unclaim', 'ticket_reopen', 'ticket_delete']) {
    const f = fixture();
    const original = structuredClone(f.values.get(f.ticketKey));
    await buttons.find(button => button.name === name).execute(f.interaction, f.client);
    assert.equal(f.trace[0], 'ack');
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(f.replies[0].embeds[0].data.title, 'Permission denied');
    assert.match(f.replies[0].embeds[0].data.description, /Only the staff team/);
    assert.deepEqual(f.values.get(f.ticketKey), original);
    assert.equal(f.publicPayloads.length, 0);
  }
});

test('ticket mutation permission lookup failure stays private and does not mutate state', async () => {
  for (const name of ['ticket_claim', 'ticket_unclaim', 'ticket_reopen', 'ticket_delete']) {
    const f = fixture({ staff: true });
    const original = structuredClone(f.values.get(f.ticketKey));
    const originalGet = f.storage.get;
    f.storage.get = async key => {
      if (key === f.ticketKey) throw new Error('Database unavailable');
      return originalGet(key);
    };
    await buttons.find(button => button.name === name).execute(f.interaction, f.client);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(f.replies[0].embeds[0].data.description, /database is temporarily unavailable/);
    assert.deepEqual(f.values.get(f.ticketKey), original);
    assert.equal(f.publicPayloads.length, 0);
  }
});

test('failed component acknowledgement skips permission reads and ticket mutations', async () => {
  for (const name of ['ticket_claim', 'ticket_unclaim', 'ticket_reopen', 'ticket_delete']) {
    const f = fixture({ staff: true });
    const original = structuredClone(f.values.get(f.ticketKey));
    f.interaction.deferUpdate = async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); };
    await buttons.find(button => button.name === name).execute(f.interaction, f.client);
    assert.equal(f.trace.some(item => item.startsWith('read:')), false);
    assert.deepEqual(f.values.get(f.ticketKey), original);
    assert.equal(f.publicPayloads.length, 0);
  }
});

test('staff claim and unclaim retain public status messages and existing state transitions', async () => {
  const f = fixture({ staff: true });
  await buttons.find(button => button.name === 'ticket_claim').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).claimedBy, f.interaction.user.id);
  assert.equal(f.trace[0], 'ack');
  assert.equal(f.replies.length, 0);
  assert.match((f.publicPayloads[0].embeds[0].toJSON?.() || f.publicPayloads[0].embeds[0]).description, /claimed/i);
  f.interaction.deferred = false;
  await buttons.find(button => button.name === 'ticket_unclaim').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).claimedBy, null);
  assert.match((f.publicPayloads[1].embeds[0].toJSON?.() || f.publicPayloads[1].embeds[0]).description, /unclaimed/i);
  assert.equal(f.replies.length, 0);
});

test('pinned messages support modern MessagePin wrappers and legacy Collections', () => {
  const message = { id: 'pinned-message' };
  assert.deepEqual(getPinnedMessages({ items: [{ pinnedTimestamp: Date.now(), message }], hasMore: false }), [message]);
  assert.deepEqual(getPinnedMessages(new Collection([[message.id, message]])), [message]);
  assert.deepEqual(getPinnedMessages({ items: [message] }), [message]);
  assert.deepEqual(getPinnedMessages(null), []);
});

test('ticket permission recovery uses the pinned Message without fetching recent history', async () => {
  const f = fixture({ record: false });
  let recentReads = 0;
  const pinned = { id: 'pinned-main', author: f.client.user, content: '<@1634506224312389802>',
    embeds: [new EmbedBuilder().setTitle('Ticket #1').setDescription('**Reason:** Original reason').toJSON()],
    createdAt: new Date() };
  f.channel.messages.fetchPins = async () => ({ items: [{ message: pinned }], hasMore: false });
  f.channel.messages.fetch = async () => { recentReads += 1; throw new Error('No recent history should be read'); };
  const context = await getTicketPermissionContext({ client: f.client, interaction: f.interaction });
  assert.equal(context.ticketData.ticketMessageId, pinned.id);
  assert.equal(context.ticketData.reason, 'Original reason');
  assert.equal(context.ticketData.userId, '1634506224312389802');
  assert.equal(recentReads, 0);
});

test('ticket permission recovery still falls back to recent history when no pinned ticket exists', async () => {
  const f = fixture({ record: false });
  let recentReads = 0;
  const main = { id: 'recent-main', author: f.client.user, content: '<@1634506224312389802>',
    embeds: [new EmbedBuilder().setTitle('Ticket #1').toJSON()], createdAt: new Date() };
  f.channel.messages.fetchPins = async () => ({ items: [{ message: { id: 'other', author: f.client.user, embeds: [] } }] });
  f.channel.messages.fetch = async () => { recentReads += 1; return new Collection([[main.id, main]]); };
  const context = await getTicketPermissionContext({ client: f.client, interaction: f.interaction });
  assert.equal(context.ticketData.ticketMessageId, main.id);
  assert.equal(recentReads, 1);
});


test('reopen restores creator access before sending the real creator mention', () => {
  const source = fs.readFileSync('src/services/ticketReliabilityService.js', 'utf8');
  const start = source.indexOf('export async function reopenTicket');
  const end = source.indexOf('\nexport async function deleteTicket', start);
  const body = source.slice(start, end);

  const categoryAt = body.indexOf('categoryTask(),');
  const restoreAt = body.indexOf('restoreReopenedTicketAccess(channel, ticketData)');
  const accessAt = body.indexOf('await channel.permissionOverwrites.edit(ticketData.userId');
  const sendAt = body.indexOf('await channel.send({');
  const mentionAt = body.indexOf('content: `<@${ticketData.userId}>`');
  assert.ok(categoryAt >= 0 && restoreAt > categoryAt);
  assert.ok(accessAt > restoreAt && sendAt > accessAt);
  assert.ok(mentionAt > sendAt);
  assert.match(body, /allowedMentions: \\{ parse: \\[\\], users: \\[String\\(ticketData\\.userId\\)\\] \\}/);
});


test('closed status and staff controls are hidden from the creator for every close', () => {
  const source = fs.readFileSync('src/services/ticketReliabilityService.js', 'utf8');
  const start = source.indexOf('export async function closeTicket');
  const end = source.indexOf('\nexport async function reopenTicket', start);
  const body = source.slice(start, end);

  const hideAt = body.indexOf('await hideClosedTicket(channel)');
  const sendAt = body.indexOf('await sendTicketStatus(channel', hideAt);
  assert.ok(hideAt >= 0 && sendAt > hideAt);
  assert.doesNotMatch(body, /actorCanManage/);
});
