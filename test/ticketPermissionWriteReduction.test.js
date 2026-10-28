import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection, OverwriteType, PermissionFlagsBits, PermissionOverwrites, PermissionsBitField,
} from 'discord.js';
import { db, getTicketData, saveTicketData } from '../src/utils/database.js';
import {
  hideClosedTicket,
  isNoopOverwriteEdit,
  readFreshTicketOverwrites,
  restoreReopenedTicketAccess,
} from '../src/services/ticketClosedAccessService.js';
import { reconcileTicketChannelState } from '../src/services/ticketReliabilityService.js';

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;
const R = PermissionFlagsBits.ReadMessageHistory;
const A = PermissionFlagsBits.AttachFiles;
const FULL = V | S | R | A;
let sequence = 0;

// A Discord double with separate server state and a Gateway cache that only
// catches up when deliverGateway() runs, like the real REST/Gateway split.
function fixture({ status = 'open', fetchMode = 'fresh' } = {}) {
  const guildId = `perm-reduce-${++sequence}`;
  const channelId = `perm-ticket-${sequence}`;
  const key = `guild:${guildId}:ticket:${channelId}`;
  const values = new Map([
    [key, { id: channelId, userId: 'creator', status, ticketNumber: '1', pinned: false }],
    [`guild:${guildId}:config`, { ticketStaffRoleId: 'staff-role' }],
  ]);
  const storage = {
    get: async name => structuredClone(values.get(name) ?? null),
    set: async (name, value) => { values.set(name, structuredClone(value)); return true; },
    isAvailable: () => true,
  };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;

  const member = (id, staff = false) => ({ id, user: { id },
    permissions: new PermissionsBitField(),
    roles: { cache: new Collection(staff ? [['staff-role', { id: 'staff-role', name: 'Staff' }]] : []) } });
  const members = new Map([['creator', member('creator')], ['claimer', member('claimer', true)]]);
  const client = { user: { id: 'bot' }, db: storage };
  const guild = {
    id: guildId, ownerId: 'owner', client,
    roles: { cache: new Collection([['staff-role', { id: 'staff-role', name: 'Staff' }]]) },
    members: { fetch: async id => members.get(id) ?? null },
    channels: { cache: new Collection() },
  };
  client.guilds = { cache: new Collection([[guildId, guild]]) };

  // A new ticket: @everyone hidden, creator and staff role with full access.
  const server = new Map([
    [guildId, { type: OverwriteType.Role, allow: 0n, deny: V }],
    ['creator', { type: OverwriteType.Member, allow: FULL, deny: 0n }],
    ['staff-role', { type: OverwriteType.Role, allow: FULL, deny: 0n }],
  ]);
  const cache = new Collection();
  const puts = [];
  let gets = 0;
  const deliverGateway = () => {
    cache.clear();
    for (const [id, entry] of server) {
      cache.set(id, { id, type: entry.type,
        allow: new PermissionsBitField(entry.allow), deny: new PermissionsBitField(entry.deny) });
    }
  };
  deliverGateway();

  const channel = {
    id: channelId, name: 'ticket-1', guild, client, parentId: null,
    permissionOverwrites: {
      cache,
      // Same merge rule as discord.js: unspecified bits come from the cache,
      // and a REST write does not update the cache until the Gateway event.
      edit: async (id, options) => {
        const existing = cache.get(id);
        const { allow, deny } = PermissionOverwrites.resolveOverwriteOptions(options, existing);
        const type = existing?.type ?? (guild.roles.cache.has(id) || id === guildId ? OverwriteType.Role : OverwriteType.Member);
        puts.push(id);
        server.set(id, { type, allow: allow.bitfield, deny: deny.bitfield });
        return channel;
      },
    },
    messages: { fetch: async () => null },
    send: async () => ({ id: 'status' }),
    setName: async name => { channel.name = name; return channel; },
  };
  if (fetchMode === 'fresh') {
    channel.fetch = async force => { assert.equal(force, true); gets += 1; deliverGateway(); return channel; };
  } else if (fetchMode === 'fails') {
    channel.fetch = async () => { gets += 1; throw Object.assign(new Error('Discord unavailable'), { code: 500 }); };
  } else if (fetchMode === 'other-instance') {
    channel.fetch = async () => { gets += 1; return { ...channel }; };
  }
  guild.channels.cache.set(channelId, channel);
  const allowed = (id, bit) => (server.get(id)?.allow & bit) === bit;
  const denied = (id, bit) => (server.get(id)?.deny & bit) === bit;
  return { channel, guild, server, cache, puts, key, values, deliverGateway, allowed, denied,
    gets: () => gets, guildId };
}

test('close skips overwrites Discord already has and still writes every real change', async () => {
  const f = fixture();
  await hideClosedTicket(f.channel, { closing: true });
  // @everyone and the staff role already match; only bot and creator change.
  assert.deepEqual([...f.puts].sort(), ['bot', 'creator']);
  assert.equal(f.gets(), 1);
  assert.ok(f.denied(f.guildId, V));
  assert.ok(f.denied('creator', V) && f.denied('creator', S));
  assert.ok(f.allowed('staff-role', FULL));
  assert.ok(f.allowed('bot', V | S | R));
  assert.deepEqual((await getTicketData(f.guildId, f.channel.id)).closedAccessSnapshot,
    [{ id: 'creator', view: true, send: true }]);
});

test('a second pass over an already closed ticket writes nothing', async () => {
  const f = fixture({ status: 'closed' });
  await hideClosedTicket(f.channel);
  f.deliverGateway();
  f.puts.length = 0;
  await hideClosedTicket(f.channel);
  assert.deepEqual(f.puts, []);
});

test('a stale Gateway cache can never cause a skipped denial', async () => {
  const f = fixture({ status: 'closed' });
  await hideClosedTicket(f.channel);
  f.deliverGateway();
  // Reopen writes the creator back in, but the Gateway event is still pending:
  // the cache keeps showing the creator as hidden (the desired close state).
  await f.channel.permissionOverwrites.edit('creator', { ViewChannel: true, SendMessages: true });
  assert.ok(f.cache.get('creator').deny.has(V), 'cache must still be stale for this test');
  f.puts.length = 0;
  await hideClosedTicket(f.channel);
  assert.ok(f.puts.includes('creator'));
  assert.ok(f.denied('creator', V) && f.denied('creator', S));
});

test('without a verified fresh read every overwrite is written, as before', async () => {
  for (const fetchMode of ['none', 'fails', 'other-instance']) {
    const f = fixture({ fetchMode });
    await hideClosedTicket(f.channel, { closing: true });
    assert.deepEqual([...f.puts].sort(), [f.guildId, 'bot', 'creator', 'staff-role'].sort(), fetchMode);
    assert.ok(f.denied('creator', V), fetchMode);
  }
});

test('rapid Close, Reopen, Close, Reopen leaves the right access with lagging Gateway events', async () => {
  const f = fixture();
  const reopen = async () => {
    const data = await getTicketData(f.guildId, f.channel.id);
    await restoreReopenedTicketAccess(f.channel, data);
    await f.channel.permissionOverwrites.edit('creator',
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
  };
  const setStatus = async status => {
    const data = await getTicketData(f.guildId, f.channel.id);
    data.status = status;
    await saveTicketData(f.guildId, f.channel.id, data);
  };
  // No Gateway event is delivered between any of these steps.
  await setStatus('closed'); await hideClosedTicket(f.channel);
  assert.ok(f.denied('creator', V));
  await setStatus('open'); await reopen();
  assert.ok(f.allowed('creator', FULL));
  await setStatus('closed'); await hideClosedTicket(f.channel);
  assert.ok(f.denied('creator', V) && f.denied('creator', S));
  await setStatus('open'); await reopen();
  assert.ok(f.allowed('creator', FULL));
  assert.ok(f.allowed('staff-role', FULL));
  assert.ok(f.denied(f.guildId, V));
});

test('open-ticket reconciliation writes owner and staff access only when Discord differs', async () => {
  const f = fixture();
  await reconcileTicketChannelState(f.channel);
  assert.deepEqual(f.puts, []);
  assert.equal(f.gets(), 1);

  f.server.set('creator', { type: OverwriteType.Member, allow: 0n, deny: V });
  f.server.delete('staff-role');
  await reconcileTicketChannelState(f.channel);
  assert.deepEqual([...f.puts].sort(), ['creator', 'staff-role']);
  assert.ok(f.allowed('creator', FULL));
  assert.ok(f.allowed('staff-role', FULL));
});

test('closed-ticket reconciliation passes after a close write nothing new', async () => {
  const f = fixture({ status: 'closed' });
  await reconcileTicketChannelState(f.channel);
  const firstPass = f.puts.length;
  assert.ok(firstPass > 0 && firstPass <= 3);
  f.deliverGateway();
  f.puts.length = 0;
  await reconcileTicketChannelState(f.channel);
  await reconcileTicketChannelState(f.channel);
  assert.deepEqual(f.puts, []);
  assert.ok(f.denied('creator', V));
});

test('isNoopOverwriteEdit only matches an exact allow/deny result', async () => {
  const fresh = new Map([['x', { allow: V | S, deny: 0n }]]);
  assert.equal(isNoopOverwriteEdit(fresh, 'x', { ViewChannel: true }), true);
  assert.equal(isNoopOverwriteEdit(fresh, 'x', { ViewChannel: true, AttachFiles: true }), false);
  assert.equal(isNoopOverwriteEdit(fresh, 'x', { SendMessages: null }), false);
  assert.equal(isNoopOverwriteEdit(fresh, 'missing', { ViewChannel: true }), false);
  assert.equal(isNoopOverwriteEdit(null, 'x', { ViewChannel: true }), false);
  const f = fixture({ fetchMode: 'fails' });
  assert.equal(await readFreshTicketOverwrites(f.channel), null);
});
