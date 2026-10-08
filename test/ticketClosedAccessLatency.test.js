import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, OverwriteType, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { db, getTicketData, saveTicketData } from '../src/utils/database.js';
import { hideClosedTicket, restoreReopenedTicketAccess } from '../src/services/ticketClosedAccessService.js';

let sequence = 0;
const flush = () => new Promise(resolve => { setImmediate(resolve); });
function fixture({ creatorStaff = false } = {}) {
  const guildId = `closed-access-${++sequence}`, channelId = `ticket-${sequence}`;
  const key = `guild:${guildId}:ticket:${channelId}`;
  const values = new Map([[key, { id: channelId, userId: 'creator', status: 'closed' }],
    [`guild:${guildId}:config`, { ticketStaffRoleId: 'staff-role' }]]);
  const trace = [], reads = [];
  const storage = { get: async name => structuredClone(values.get(name) ?? null),
    set: async (name, value) => { trace.push('save'); values.set(name, structuredClone(value)); return true; } };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const member = (id, staff = false, admin = false) => ({ id,
    permissions: new PermissionsBitField(admin ? [PermissionFlagsBits.Administrator] : []),
    roles: { cache: new Collection(staff ? [['staff-role', { id: 'staff-role', name: 'Staff' }]] : []) } });
  const members = new Map([['creator', member('creator', creatorStaff)], ['guest', member('guest')],
    ['staff-member', member('staff-member', true)], ['owner', member('owner')], ['admin', member('admin', false, true)]]);
  const client = { user: { id: 'bot' }, db: storage };
  const guild = { id: guildId, ownerId: 'owner', client,
    roles: { cache: new Collection([['staff-role', { id: 'staff-role', name: 'Staff' }],
      ['admin-role', { permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]) }]]) },
    members: { fetch: async id => { reads.push(id); return members.get(id) ?? null; } } };
  const cache = new Collection();
  for (const [id, type] of [['creator', OverwriteType.Member], ['guest', OverwriteType.Member],
    ['staff-member', OverwriteType.Member], ['owner', OverwriteType.Member], ['admin', OverwriteType.Member],
    ['ordinary-role', OverwriteType.Role], ['admin-role', OverwriteType.Role]]) {
    cache.set(id, { id, type, allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]), deny: new PermissionsBitField() });
  }
  const edits = [];
  const channel = { id: channelId, guild, client, permissionOverwrites: { cache, edit: async (id, permissions) => {
    trace.push(`edit:${id}`); edits.push({ id, permissions });
    const current = cache.get(id) || { id, type: OverwriteType.Role, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
    const allow = new PermissionsBitField(current.allow.bitfield), deny = new PermissionsBitField(current.deny.bitfield);
    for (const [permission, value] of Object.entries(permissions)) {
      const bit = PermissionFlagsBits[permission];
      if (value === true) { allow.add(bit); deny.remove(bit); }
      else if (value === false) { deny.add(bit); allow.remove(bit); }
      else { allow.remove(bit); deny.remove(bit); }
    }
    cache.set(id, { ...current, allow, deny });
    return channel;
  } } };
  return { channel, guild, edits, trace, reads, members, values, key };
}

test('closed access starts independent member lookups before an earlier lookup resolves', async () => {
  const f = fixture();
  const fetch = f.guild.members.fetch;
  let release;
  f.guild.members.fetch = async id => {
    if (id === 'creator' && !release) await new Promise(resolve => { release = resolve; });
    return fetch(id);
  };
  const pending = hideClosedTicket(f.channel);
  await flush();
  const startedWhileHeld = [...f.reads];
  release();
  await pending;
  assert.ok(startedWhileHeld.includes('guest'));
  assert.ok(startedWhileHeld.includes('staff-member'));
  assert.equal(f.reads.filter(id => id === 'creator').length, 1);
});

test('closed access persists its snapshot before starting unique independent permission edits', async () => {
  const f = fixture();
  const edit = f.channel.permissionOverwrites.edit;
  let release;
  const started = [];
  f.channel.permissionOverwrites.edit = async (id, permissions) => {
    started.push(id);
    if (id === f.guild.id) await new Promise(resolve => { release = resolve; });
    return edit(id, permissions);
  };
  const pending = hideClosedTicket(f.channel);
  await flush();
  const startedWhileHeld = [...started];
  release();
  await pending;
  assert.ok(startedWhileHeld.includes('bot'));
  assert.ok(startedWhileHeld.includes('guest'));
  assert.equal(started.filter(id => id === 'creator').length, 1);
  assert.equal(new Set(started).size, started.length);
  assert.equal(f.trace[0], 'save');
  assert.deepEqual((await getTicketData(f.guild.id, f.channel.id)).closedAccessSnapshot,
    ['creator', 'guest', 'ordinary-role'].map(id => ({ id, view: true, send: true })));
});

test('repeated closes preserve the access snapshot and creator, staff, owner and admin permissions', async () => {
  for (const creatorStaff of [false, true]) {
    const f = fixture({ creatorStaff });
    await hideClosedTicket(f.channel);
    const firstEdits = f.edits.length;
    const snapshot = (await getTicketData(f.guild.id, f.channel.id)).closedAccessSnapshot;
    await hideClosedTicket(f.channel);
    assert.equal(f.edits.length, firstEdits * 2);
    assert.deepEqual((await getTicketData(f.guild.id, f.channel.id)).closedAccessSnapshot, snapshot);
    for (const [id, allowed] of [['creator', creatorStaff], ['guest', false], ['ordinary-role', false],
      ['staff-member', true], ['owner', true], ['admin', true], ['staff-role', true], ['bot', true]]) {
      const overwrite = f.channel.permissionOverwrites.cache.get(id);
      assert.equal(overwrite.allow.has(PermissionFlagsBits.ViewChannel), allowed, id);
      assert.equal(overwrite.deny.has(PermissionFlagsBits.ViewChannel), !allowed, id);
    }
    assert.equal(f.edits.some(edit => edit.id === 'admin-role'), false);
  }
});

test('a failed permission edit does not release close until other in-flight edits settle and retry repairs it', async () => {
  const f = fixture();
  const edit = f.channel.permissionOverwrites.edit;
  let release, settled = false;
  let fail = true;
  f.channel.permissionOverwrites.edit = async (id, permissions) => {
    if (id === f.guild.id && fail) { fail = false; throw new Error('Discord permission failure'); }
    if (id === 'guest' && !release) await new Promise(resolve => { release = resolve; });
    return edit(id, permissions);
  };
  const pending = hideClosedTicket(f.channel).then(() => { settled = true; }, error => { settled = true; return error; });
  await flush();
  const remainedPending = !settled;
  release?.();
  const result = await pending;
  assert.ok(remainedPending, 'another action must not race outstanding close permission writes');
  assert.match(result.message, /Discord permission failure/);
  await hideClosedTicket(f.channel);
  assert.equal(f.channel.permissionOverwrites.cache.get(f.guild.id).deny.has(PermissionFlagsBits.ViewChannel), true);
});

test('a close after reopen never skips permission denial based on a stale Discord cache', async () => {
  const f = fixture();
  await hideClosedTicket(f.channel);
  const writes = [];
  // Discord REST permission edits complete before Gateway refreshes this cache.
  f.channel.permissionOverwrites.edit = async (id, permissions) => { writes.push({ id, permissions }); };
  const data = await getTicketData(f.guild.id, f.channel.id);
  data.status = 'open';
  await restoreReopenedTicketAccess(f.channel, data);
  await f.channel.permissionOverwrites.edit(data.userId, { ViewChannel: true, SendMessages: true });
  data.status = 'closed';
  await saveTicketData(f.guild.id, f.channel.id, data);
  writes.length = 0;
  await hideClosedTicket(f.channel);
  for (const id of ['creator', 'guest', 'ordinary-role']) {
    assert.equal(writes.find(write => write.id === id)?.permissions.ViewChannel, false, id);
  }
});

test('failed reopen restoration waits for other allow writes before another close can begin', async () => {
  const f = fixture();
  await hideClosedTicket(f.channel);
  const edit = f.channel.permissionOverwrites.edit;
  let release, settled = false, fail = true;
  f.channel.permissionOverwrites.edit = async (id, permissions) => {
    if (id === 'guest') await new Promise(resolve => { release = resolve; });
    if (id === 'ordinary-role' && fail) { fail = false; throw new Error('Discord restoration failure'); }
    return edit(id, permissions);
  };
  const pending = restoreReopenedTicketAccess(f.channel).then(() => { settled = true; }, error => { settled = true; return error; });
  await flush();
  const remainedPending = !settled;
  release();
  const error = await pending;
  assert.ok(remainedPending, 'later close must not race a delayed reopen allow write');
  assert.match(error.message, /Discord restoration failure/);
  assert.ok((await getTicketData(f.guild.id, f.channel.id)).closedAccessSnapshot);
  f.channel.permissionOverwrites.edit = edit;
  await hideClosedTicket(f.channel);
  assert.equal(f.channel.permissionOverwrites.cache.get('guest').deny.has(PermissionFlagsBits.ViewChannel), true);
  await restoreReopenedTicketAccess(f.channel);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).closedAccessSnapshot, undefined);
  assert.equal(f.channel.permissionOverwrites.cache.get('guest').allow.has(PermissionFlagsBits.ViewChannel), true);
});
