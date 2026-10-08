import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField } from 'discord.js';
import { db, getTicketData } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';
import { closeTicket, reopenTicket, deleteTicket } from '../src/services/ticketReliabilityService.js';
import { DELETE_DELAY_MS } from '../src/services/ticketDeleteService.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });
let sequence = 0;
function fixture(t) {
  const guildId = `ticket-burst-${++sequence}`, channelId = 'ticket';
  const key = `guild:${guildId}:ticket:${channelId}`;
  const values = new Map([[key, { id: channelId, userId: 'creator', status: 'closed', ticketNumber: 1,
    transcriptArchivedAt: '2026-10-08T00:00:00.000Z' }],
  [`guild:${guildId}:config`, { ticketStaffRoleId: 'staff-role', logging: { enabled: false },
    ticketLogsChannelId: 'logs', ticketTranscriptChannelId: 'transcripts' }]]);
  t.mock.property(db, 'initialized', true);
  t.mock.method(db, 'get', async id => structuredClone(values.get(id) ?? null));
  t.mock.method(db, 'set', async (id, value) => { values.set(id, structuredClone(value)); return true; });
  t.mock.method(db, 'delete', async id => { values.delete(id); return true; });
  const client = { user: { id: 'bot' }, db: { get: id => db.get(id), isAvailable: () => true } };
  const actor = { id: 'staff', user: { id: 'staff' }, permissions: new PermissionsBitField(),
    roles: { cache: new Collection([['staff-role', { id: 'staff-role', name: 'Staff' }]]) } };
  const creator = { id: 'creator', user: { id: 'creator' }, permissions: new PermissionsBitField(), roles: { cache: new Collection() } };
  const guild = { id: guildId, client, ownerId: 'owner', roles: { cache: actor.roles.cache },
    members: { cache: new Collection([[actor.id, actor], [creator.id, creator]]), fetch: async id => id === actor.id ? actor : creator },
    channels: { cache: new Collection(), fetch: async () => null } };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const statuses = [], errors = [];
  let acknowledgements = 0, deleted = 0;
  const channel = { id: channelId, guild, client, name: 'ticket-1', isTextBased: () => true,
    permissionOverwrites: { cache: new Collection(), edit: async () => {} },
    messages: { fetch: async () => new Collection() },
    send: async payload => { statuses.push(payload); return { id: `status-${statuses.length}`, delete: async () => {} }; },
    delete: async () => { deleted += 1; } };
  guild.channels.cache.set(channelId, channel);
  const click = () => {
    const interaction = { guildId, channelId, guild, channel, client, member: actor, user: actor.user,
      message: { id: 'close-status', edit: async () => {} },
      deferUpdate: async () => { acknowledgements += 1; interaction.deferred = true; },
      deferReply: async () => assert.fail('Repeated ticket controls must acknowledge silently'),
      followUp: async payload => { errors.push(payload); return { id: 'private' }; } };
    return interaction;
  };
  return { guild, channel, actor, client, key, statuses, errors, click, values,
    acknowledgements: () => acknowledgements, deleted: () => deleted,
    data: () => getTicketData(guildId, channelId) };
}

test('overlapping Reopen clicks share completion instead of queueing false not-closed errors', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.channel.permissionOverwrites.edit = async () => gate;
  const handler = buttons.find(button => button.name === 'ticket_reopen');
  const actions = Array.from({ length: 8 }, () => handler.execute(f.click(), f.client));
  await settle();
  assert.equal(f.acknowledgements(), 8);
  assert.equal(f.statuses.length, 0, 'Creator access must be restored before the reopen notification');
  release();
  await Promise.all(actions);
  assert.equal((await f.data()).status, 'open');
  assert.equal(f.statuses.length, 1);
  assert.deepEqual(f.errors, [], 'A duplicate pending reopen is already being completed, not an invalid action');
});

test('overlapping Delete clicks share one archival and deletion result without private error spam', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = f.channel.send;
  f.channel.send = async payload => { await gate; return send(payload); };
  const handler = buttons.find(button => button.name === 'ticket_delete');
  const actions = Array.from({ length: 8 }, () => handler.execute(f.click(), f.client));
  await settle();
  assert.equal(f.acknowledgements(), 8);
  release();
  await Promise.all(actions);
  assert.equal((await f.data()).status, 'deleted');
  assert.equal(f.statuses.length, 1);
  assert.deepEqual(f.errors, []);
  t.mock.timers.tick(DELETE_DELAY_MS);
  await settle();
  assert.equal(f.deleted(), 1);
});

test('alternating Reopen Close Reopen remains three ordered actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  f.channel.permissionOverwrites.edit = async () => { if (++writes === 1) await gate; };
  const first = reopenTicket(f.channel, f.actor);
  await settle();
  const close = closeTicket(f.channel, f.actor, 'Resolved');
  const second = reopenTicket(f.channel, f.actor);
  release();
  await Promise.all([first, close, second]);
  assert.equal((await f.data()).status, 'open');
  assert.deepEqual(f.statuses.map(payload => payload.embeds[0].toJSON?.().title || payload.embeds[0].title),
    ['Ticket reopened', 'Ticket closed', 'Ticket reopened']);
});

test('failed pending actions remain failures and a later retry can succeed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const set = db.set;
  const failingWrite = t.mock.method(db, 'set', async (key, data) => {
    if (key === f.key) { await gate; throw new Error('Persistent write failed'); }
    return set(key, data);
  });
  const actions = Array.from({ length: 4 }, () => deleteTicket(f.channel, f.actor));
  await settle();
  release();
  const results = await Promise.allSettled(actions);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(f.statuses.length, 0);
  assert.equal((await f.data()).status, 'closed');
  failingWrite.mock.restore();
  await deleteTicket(f.channel, f.actor);
  assert.equal((await f.data()).status, 'deleted');
  assert.equal(f.statuses.length, 1);
});

test('legacy close callers each clear their own private thinking response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.channel.permissionOverwrites.edit = async () => gate;
  const cleared = [];
  const first = closeTicket(f.channel, f.actor, 'Resolved', { onVisible: async () => { cleared.push('first'); } });
  const second = closeTicket(f.channel, f.actor, 'Resolved', { onVisible: async () => { cleared.push('second'); } });
  await settle();
  assert.deepEqual(cleared, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(cleared, ['first', 'second']);
});
