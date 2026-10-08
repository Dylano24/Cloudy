import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, PermissionsBitField } from 'discord.js';
import { db, getTicketKey } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';

let sequence = 0;
const flush = () => new Promise(resolve => { setImmediate(resolve); });

function fixture() {
  const guildId = `16328826478385${String(++sequence).padStart(5, '0')}`;
  const channelId = `16545386226726${String(sequence).padStart(5, '0')}`;
  const actorId = '1634506224312389801';
  const creatorId = '1634506224312389802';
  const staffRoleId = '1634506224312389810';
  const ticketKey = getTicketKey(guildId, channelId);
  const values = new Map([[`guild:${guildId}:config`, { ticketStaffRoleId: staffRoleId, logging: { enabled: false } }]]);
  const publicReplies = [], privateReplies = [];
  let releaseRecovery, rejectRecovery, acknowledgements = 0, writes = 0;
  const storage = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => {
      if (key === ticketKey && ++writes === 1) {
        await new Promise((resolve, reject) => { releaseRecovery = resolve; rejectRecovery = reject; });
      }
      values.set(key, structuredClone(value));
      return true;
    },
  };
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = storage;
  const client = { user: { id: 'bot' }, db: { ...storage, isAvailable: () => true } };
  const role = { id: staffRoleId, name: 'Staff' };
  const member = {
    id: actorId, user: { id: actorId, username: 'Staff' }, permissions: new PermissionsBitField(),
    roles: { cache: new Collection([[staffRoleId, role]]) },
  };
  const guild = {
    id: guildId, ownerId: 'owner', client, roles: { cache: new Collection([[staffRoleId, role]]) },
    channels: { cache: new Collection() },
  };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const main = {
    id: 'pinned-ticket', author: client.user, content: `<@${creatorId}>`, createdAt: new Date(),
    embeds: [{ title: 'Ticket #1', description: '**Reason:** Original reason' }],
    editable: true, flags: { has: () => false }, edit: async () => main,
  };
  const channel = {
    id: channelId, guild, client, name: 'ticket-1', isTextBased: () => true,
    messages: {
      fetchPins: async () => ({ items: [{ message: main }] }),
      fetch: async id => { assert.equal(id, main.id); return main; },
    },
    send: async payload => { publicReplies.push(JSON.parse(JSON.stringify(payload))); return { id: 'claim-status' }; },
  };
  guild.channels.cache.set(channelId, channel);
  const interaction = {
    id: `recovery-${sequence}`, customId: 'ticket_claim', guildId, channelId, guild, channel, client,
    member, user: member.user, message: main,
    deferUpdate: async () => { acknowledgements += 1; interaction.deferred = true; },
    deferReply: async () => assert.fail('recovered ticket clicks must acknowledge without a thinking reply'),
    editReply: async () => assert.fail('recovered ticket errors must preserve the public main message'),
    followUp: async payload => { privateReplies.push(payload); return { id: 'private-error' }; },
  };
  return {
    interaction, client, ticketKey, actorId, values, publicReplies, privateReplies,
    acknowledgements: () => acknowledgements, recoveryStarted: () => typeof releaseRecovery === 'function',
    finishRecovery: () => releaseRecovery?.(),
    failRecovery: () => rejectRecovery?.(new Error('Persistent database unavailable')),
  };
}

test('a recovered ticket Claim waits for its durable recovery save after immediately acknowledging', async t => {
  const f = fixture();
  const action = buttons.find(button => button.name === 'ticket_claim').execute(f.interaction, f.client);
  t.after(async () => { f.finishRecovery(); await action; });
  await flush();
  assert.equal(f.acknowledgements(), 1);
  assert.equal(f.recoveryStarted(), true);
  assert.equal(f.values.has(f.ticketKey), false);
  assert.equal(f.publicReplies.length, 0);
  assert.equal(f.privateReplies.length, 0, 'a valid recovered ticket must not be rejected while its recovery save is pending');
  f.finishRecovery();
  await action;
  assert.equal(f.values.get(f.ticketKey).claimedBy, f.actorId);
  assert.equal(f.values.get(f.ticketKey).reason, 'Original reason');
  assert.deepEqual(f.publicReplies.map(payload => payload.embeds[0].title), ['Ticket claimed']);
  assert.equal(f.privateReplies.length, 0);
});

test('a failed recovered ticket save produces a private database error without claiming or reporting success', async t => {
  const f = fixture();
  const action = buttons.find(button => button.name === 'ticket_claim').execute(f.interaction, f.client);
  t.after(async () => { f.finishRecovery(); await action; });
  await flush();
  assert.equal(f.acknowledgements(), 1);
  assert.equal(f.recoveryStarted(), true);
  f.failRecovery();
  await action;
  assert.equal(f.values.has(f.ticketKey), false);
  assert.equal(f.publicReplies.length, 0);
  assert.equal(f.privateReplies.length, 1);
  assert.equal(f.privateReplies[0].flags, MessageFlags.Ephemeral);
  const error = f.privateReplies[0].embeds[0];
  assert.match(error.description || error.data?.description, /database.*temporarily unavailable/i);
});
