import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChannelType, Collection, EmbedBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { db, getTicketData, getTicketKey } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';
import { getTicketPermissionContext } from '../src/utils/ticket/ticketPermissions.js';
import { getPinnedMessages } from '../src/utils/messagePins.js';
import { claimTicket, updateTicketPriority } from '../src/services/ticketReliabilityService.js';
import modals from '../src/interactions/modals/ticket/createTicketUi.js';
import { installInteractionMessageLifecycle } from '../src/utils/interactionMessageLifecycle.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

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

function nextInteraction(f, customId) {
  const interaction = { ...f.interaction, id: `${customId}-${++sequence}`, customId, deferred: false, replied: false };
  interaction.deferUpdate = async () => { f.trace.push(`ack:${customId}`); interaction.deferred = true; };
  interaction.deferReply = async () => assert.fail(`${customId} must not display a thinking reply`);
  interaction.editReply = async () => assert.fail(`${customId} must not overwrite the public ticket`);
  interaction.deleteReply = async () => assert.fail(`${customId} must not delete the public ticket`);
  interaction.followUp = async payload => { f.replies.push(payload); return { id: `private-${f.replies.length}` }; };
  return interaction;
}

function captureTicketLogs(f) {
  const logs = [];
  const creator = { id: f.values.get(f.ticketKey).userId, user: { username: 'Creator', displayAvatarURL: () => 'https://example.com/creator.png' } };
  f.guild.members = { me: {}, cache: new Collection([[creator.id, creator]]), fetch: async id => id === creator.id ? creator : f.interaction.member };
  f.values.get(`guild:${f.guild.id}:config`).ticketLogsChannelId = 'logs';
  f.guild.channels.cache.set('logs', { id: 'logs', type: ChannelType.GuildText, isSendable: () => true,
    permissionsFor: () => ({ has: () => true }), send: async payload => { logs.push(payload); return { id: `log-${logs.length}` }; } });
  return logs;
}

test('claim spam acknowledges every click before a slow write and sends one public status', async () => {
  const f = fixture({ staff: true });
  const logs = captureTicketLogs(f);
  let finishWrite, writes = 0;
  const set = f.storage.set;
  f.storage.set = async (key, value) => {
    if (key === f.ticketKey) {
      writes += 1;
      if (writes === 1) await new Promise(resolve => { finishWrite = resolve; });
    }
    return set(key, value);
  };
  const handler = buttons.find(button => button.name === 'ticket_claim');
  const clicks = Array.from({ length: 8 }, () => nextInteraction(f, 'ticket_claim'));
  const actions = clicks.map(click => handler.execute(click, f.client));
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(f.trace.filter(item => item === 'ack:ticket_claim').length, 8);
  assert.equal(typeof finishWrite, 'function');
  assert.equal(f.publicPayloads.length, 0);
  finishWrite();
  await Promise.all(actions);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(writes, 1);
  assert.equal(f.publicPayloads.length, 1);
  assert.equal(f.replies.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].embeds[0].toJSON().title, 'Ticket claimed');
  assert.equal(logs[0].embeds[0].toJSON().color, 0x57F287);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).claimedBy, f.interaction.user.id);
});

test('same-actor claim retries a failed main-message paint without duplicating its status or log', async () => {
  const f = fixture({ staff: true });
  const logs = captureTicketLogs(f);
  f.values.get(f.ticketKey).ticketMessageId = 'main-ticket';
  const edits = [];
  const main = { id: 'main-ticket', author: f.client.user, editable: true, embeds: [{ title: 'Ticket #1' }],
    edit: async payload => {
      edits.push(payload);
      if (edits.length === 1) throw new Error('Temporary Discord edit failure');
      return main;
    } };
  f.channel.messages.fetch = async () => main;
  const handler = buttons.find(button => button.name === 'ticket_claim');
  await handler.execute(nextInteraction(f, 'ticket_claim'), f.client);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(edits.length, 1);
  await handler.execute(nextInteraction(f, 'ticket_claim'), f.client);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(edits.length, 2);
  assert.equal(edits[1].components[0].toJSON().components[0].custom_id, 'ticket_unclaim');
  assert.equal(f.publicPayloads.length, 1);
  assert.equal(logs.length, 1);
});

test('a delayed permission snapshot cannot overwrite a completed ticket mutation', async () => {
  const f = fixture({ staff: true });
  const stale = structuredClone(f.values.get(f.ticketKey));
  await claimTicket(f.channel, f.interaction.user, stale);
  await updateTicketPriority(f.channel, 'high', f.interaction.user, stale);
  const saved = await getTicketData(f.guild.id, f.channel.id);
  assert.equal(saved.claimedBy, f.interaction.user.id);
  assert.equal(saved.priority, 'high');
});

test('delete and reopen clicks share a queue and cannot reopen an archived deletion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ staff: true });
  Object.assign(f.values.get(f.ticketKey), { status: 'closed', transcriptArchivedAt: '2026-10-08T00:00:00.000Z' });
  Object.assign(f.values.get(`guild:${f.guild.id}:config`), { ticketLogsChannelId: 'logs', ticketTranscriptChannelId: 'transcripts' });
  let finishNotice, permissionEdits = 0;
  f.channel.permissionOverwrites = { edit: async () => { permissionEdits += 1; } };
  f.channel.send = async payload => {
    f.publicPayloads.push(payload);
    if (payload.embeds?.[0]?.title === 'Ticket deleted') await new Promise(resolve => { finishNotice = resolve; });
    return { id: `notice-${f.publicPayloads.length}` };
  };
  f.channel.delete = async () => {};
  const deletion = buttons.find(button => button.name === 'ticket_delete').execute(nextInteraction(f, 'ticket_delete'), f.client);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(typeof finishNotice, 'function');
  const reopening = buttons.find(button => button.name === 'ticket_reopen').execute(nextInteraction(f, 'ticket_reopen'), f.client);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.ok(f.trace.includes('ack:ticket_reopen'));
  const beforeArchive = await getTicketData(f.guild.id, f.channel.id);
  finishNotice();
  await Promise.all([deletion, reopening]);
  assert.equal(beforeArchive.status, 'closed');
  assert.equal(permissionEdits, 0);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'deleted');
  assert.equal(f.publicPayloads.length, 1);
  assert.match(f.replies[0].embeds[0].description, /deleted|deletion/);
});

test('priority buttons silently acknowledge before slow permission IO and keep the private final payload', async () => {
  for (const customId of ['ticket_priority_menu', 'ticket_priority']) {
    const f = fixture({ staff: true });
    const interaction = nextInteraction(f, customId);
    let finishRead;
    const get = f.storage.get;
    f.storage.get = key => key === f.ticketKey
      ? new Promise(resolve => { finishRead = () => { f.storage.get = get; resolve(structuredClone(f.values.get(key))); }; })
      : get(key);
    const action = buttons.find(button => button.name === customId).execute(interaction, f.client, ['high']);
    await new Promise(resolve => { setImmediate(resolve); });
    assert.equal(f.trace[0], `ack:${customId}`);
    assert.equal(typeof finishRead, 'function');
    finishRead();
    await action;
    assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(f.replies[0].embeds[0].title, customId === 'ticket_priority_menu' ? 'Ticket priority' : 'Priority Updated');
    assert.equal(Boolean(f.replies[0].components.length), customId === 'ticket_priority_menu');
  }
});

test('button close modal clears loading before a slow database read and preserves the public ticket on failure', async () => {
  const f = fixture({ staff: true });
  const interaction = nextInteraction(f, 'ticket_close_modal');
  interaction.isFromMessage = () => true;
  interaction.fields = { getTextInputValue: () => 'Resolved' };
  let finishRead;
  const get = f.storage.get;
  f.storage.get = key => key === f.ticketKey
    ? new Promise((_, reject) => { finishRead = () => reject(new Error('Database unavailable')); })
    : get(key);
  const action = modals.find(modal => modal.name === 'ticket_close_modal').execute(interaction, f.client);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(f.trace[0], 'ack:ticket_close_modal');
  assert.equal(typeof finishRead, 'function');
  finishRead();
  await action;
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(f.replies[0].content, /database is temporarily unavailable/);
  assert.equal(f.values.get(f.ticketKey).status, 'open');
  assert.equal(f.publicPayloads.length, 0);
});

test('concurrent close submits clear loading during slow permission edits and retain one final status and log', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ staff: true });
  const logs = captureTicketLogs(f);
  let finishPermission;
  f.channel.permissionOverwrites = { cache: new Collection(), edit: async () => {
    if (!finishPermission) await new Promise(resolve => { finishPermission = resolve; });
  } };
  const handler = modals.find(modal => modal.name === 'ticket_close_modal');
  const clicks = Array.from({ length: 4 }, () => {
    const interaction = nextInteraction(f, 'ticket_close_modal');
    interaction.isFromMessage = () => true;
    interaction.fields = { getTextInputValue: () => 'Resolved' };
    return interaction;
  });
  const actions = clicks.map(click => handler.execute(click, f.client));
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(f.trace.filter(item => item === 'ack:ticket_close_modal').length, 4);
  assert.equal(typeof finishPermission, 'function');
  assert.equal(f.publicPayloads.length, 0);
  assert.equal(f.replies.length, 0);
  finishPermission();
  await Promise.all(actions);
  await new Promise(resolve => { setImmediate(resolve); });
  const saved = await getTicketData(f.guild.id, f.channel.id);
  assert.equal(saved.status, 'closed');
  assert.equal(saved.closeReason, 'Resolved');
  assert.equal(f.publicPayloads.length, 1);
  assert.equal(f.publicPayloads[0].embeds[0].title, 'Ticket closed');
  assert.equal(f.publicPayloads[0].embeds[0].color, 0xFF7A00);
  assert.deepEqual(f.publicPayloads[0].components[0].toJSON().components.map(button => button.custom_id), ['ticket_reopen', 'ticket_delete']);
  assert.equal(f.replies.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].embeds[0].toJSON().title, 'Ticket closed');
  assert.equal(logs[0].embeds[0].toJSON().color, 0xFF7A00);
});

test('a failed close persistence stays visible privately without posting a success', async () => {
  const f = fixture({ staff: true });
  const interaction = nextInteraction(f, 'ticket_close_modal');
  interaction.isFromMessage = () => true;
  interaction.fields = { getTextInputValue: () => 'Resolved' };
  f.storage.set = async key => { if (key === f.ticketKey) throw new Error('PostgreSQL write unavailable'); return true; };
  await modals.find(modal => modal.name === 'ticket_close_modal').execute(interaction, f.client);
  assert.equal(f.trace[0], 'ack:ticket_close_modal');
  assert.equal(f.values.get(f.ticketKey).status, 'open');
  assert.equal(f.publicPayloads.length, 0);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(f.replies[0].content, /error occurred while closing/);
});

test('silent priority final replies delete their own private message after exactly ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ staff: true });
  const interaction = nextInteraction(f, 'ticket_priority');
  const deleted = [];
  interaction.webhook = { deleteMessage: async id => deleted.push(id) };
  await buttons.find(button => button.name === 'ticket_priority').execute(interaction, f.client, ['high']);
  t.mock.timers.tick(9_999);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, ['private-1']);
});

test('a button close error expires after ten seconds without editing or deleting its source transcript', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installInteractionMessageLifecycle();
  const f = fixture({ staff: true });
  const interaction = nextInteraction(f, 'ticket_close_modal');
  const deleted = [];
  interaction.message = { id: 'transcript', attachments: [{ name: 'ticket-transcript.html' }], embeds: [{ title: 'Ticket transcript' }], components: [] };
  const original = structuredClone(interaction.message);
  interaction.isFromMessage = () => true;
  interaction.fields = { getTextInputValue: () => 'Resolved' };
  interaction.webhook = { deleteMessage: async id => deleted.push(id) };
  interaction.followUp = async payload => {
    f.replies.push(payload);
    return { id: 'close-error', ...payload, flags: { has: flag => flag === MessageFlags.Ephemeral } };
  };
  f.storage.set = async () => { throw new Error('PostgreSQL write unavailable'); };
  InteractionHelper.patchInteractionResponses(interaction);
  await modals.find(modal => modal.name === 'ticket_close_modal').execute(interaction, f.client);
  assert.equal(f.replies.length, 1);
  t.mock.timers.tick(9_999);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deleted, ['close-error']);
  assert.deepEqual(interaction.message, original);
});

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
  assert.ok(body.includes('allowedMentions: { parse: [], users: [String(ticketData.userId)] }'));
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
