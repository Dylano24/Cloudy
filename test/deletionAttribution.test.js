import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import {
  DELETION_TYPES,
  installCloudyDeletionRecorder,
  isBotActionFeedback,
  primeDeletionAuditBaseline,
  rememberMessageDeleter,
  resetDeletionAttributionState,
  resolveBulkDeletion,
  resolveMessageDeleter,
} from '../src/services/deletionAttributionService.js';
import { messageLogDestination, messageLogAuthorType, CLOUDY_GUILD_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

const fast = { attemptDelaysMs: [0, 0, 0] };
// Time passes between Cloudy's startup baseline and a later deletion.
const later = () => new Promise(resolve => { setTimeout(resolve, 5); });
async function prime(guild) {
  const primed = await primeDeletionAuditBaseline(guild);
  await later();
  return primed;
}
const client = { user: { id: 'cloudy' } };

// A guild whose audit log behaves like Discord's: one list per action type,
// repeated deletions bump extra.count on the same entry.
function auditGuild(id) {
  const state = { delete: [], ban: [], bulk: [], reads: 0, fail: false };
  const guild = {
    id,
    async fetchAuditLogs({ type }) {
      state.reads += 1;
      if (state.fail) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const list = type === AuditLogEvent.MessageDelete ? state.delete
        : type === AuditLogEvent.MemberBanAdd ? state.ban : state.bulk;
      return { entries: new Collection(list.map(entry => [entry.id, { ...entry, extra: entry.extra ? { ...entry.extra } : entry.extra }])) };
    },
  };
  const deleteEntry = (entryId, executorId, targetId, channelId, count = 1, createdTimestamp = Date.now()) => {
    const entry = { id: entryId, executor: { id: executorId, bot: executorId === 'cloudy' }, target: { id: targetId }, createdTimestamp, extra: { channel: { id: channelId }, count } };
    state.delete.unshift(entry);
    return entry;
  };
  return { guild, state, deleteEntry };
}

const deleted = (guild, id, authorId, extra = {}) => ({
  id, guild, channelId: 'channel', client,
  author: authorId ? { id: authorId, bot: authorId === 'cloudy' || authorId.startsWith('bot') } : null,
  ...extra,
});

test.beforeEach(() => resetDeletionAttributionState());

test('explicit staff and AutoMod deletion intents identify the real actor', async () => {
  const message = { id: 'deletion-intent', guild: { id: 'attribution-guild' }, client };
  rememberMessageDeleter(message, { id: 'staff' });
  assert.deepEqual(await resolveMessageDeleter(message), { id: 'staff', label: '<@staff>', source: 'staff', type: DELETION_TYPES.staff });
  rememberMessageDeleter(message, { id: 'cloudy' }, 'automod');
  assert.deepEqual(await resolveMessageDeleter(message), { id: 'cloudy', label: '<@cloudy> (AutoMod)', source: 'automod', type: DELETION_TYPES.automod });
});

test('a member deleting their own message is identified as the author', async () => {
  const { guild, deleteEntry } = auditGuild('self-guild');
  deleteEntry('old', 'staff', 'someone-else', 'channel', 4, Date.now() - 600_000);
  assert.equal(await prime(guild), true);
  const result = await resolveMessageDeleter(deleted(guild, 'own', 'member'), fast);
  assert.deepEqual(result, { id: 'member', label: '<@member>', source: 'self', type: DELETION_TYPES.self });
});

test('staff deleting a message is found through an aggregated audit entry (count bump, old timestamp)', async () => {
  const { guild, deleteEntry } = auditGuild('aggregate-guild');
  const entry = deleteEntry('merged', 'staff', 'member', 'channel', 3, Date.now() - 10 * 60_000);
  await prime(guild);
  entry.extra.count = 4; // Discord merged this deletion into the old entry.
  const staffDeletion = await resolveMessageDeleter(deleted(guild, 'removed-by-staff', 'member'), fast);
  assert.deepEqual(staffDeletion, { id: 'staff', label: '<@staff>', source: 'audit', type: DELETION_TYPES.staff });
  // The same increment can never be used twice: the member's own deletion
  // right after it is still the member's.
  const ownDeletion = await resolveMessageDeleter(deleted(guild, 'removed-by-member', 'member'), fast);
  assert.equal(ownDeletion.source, 'self');
  assert.equal(ownDeletion.id, 'member');
});

test('simultaneous staff deletions of one author are each attributed once', async () => {
  const { guild, deleteEntry } = auditGuild('parallel-guild');
  await prime(guild);
  deleteEntry('burst', 'staff', 'member', 'channel', 2);
  const results = await Promise.all([
    resolveMessageDeleter(deleted(guild, 'first', 'member'), fast),
    resolveMessageDeleter(deleted(guild, 'second', 'member'), fast),
  ]);
  assert.deepEqual(results.map(result => result.id), ['staff', 'staff']);
  assert.ok(guild.fetchAuditLogs, 'audit reads are shared, not one per deletion');
});

test('a staff deletion and a self-deletion of the same author at the same moment name nobody', async () => {
  const { guild, deleteEntry } = auditGuild('mixed-guild');
  await prime(guild);
  deleteEntry('single', 'staff', 'member', 'channel', 1);
  const results = await Promise.all([
    resolveMessageDeleter(deleted(guild, 'a', 'member'), fast),
    resolveMessageDeleter(deleted(guild, 'b', 'member'), fast),
  ]);
  // One increment, two deletions: Discord cannot say which one staff removed.
  assert.deepEqual(results.map(result => result.label), ['Unknown', 'Unknown']);
  assert.ok(results.every(result => result.type === DELETION_TYPES.unknown));
});

test('two different executors for one author and channel are never guessed', async () => {
  const { guild, deleteEntry } = auditGuild('two-executors');
  await prime(guild);
  deleteEntry('one', 'staff', 'member', 'channel');
  deleteEntry('two', 'other-staff', 'member', 'channel');
  assert.equal((await resolveMessageDeleter(deleted(guild, 'x', 'member'), fast)).label, 'Unknown');
});

test('evidence must match channel and author', async () => {
  const { guild, deleteEntry } = auditGuild('match-guild');
  await prime(guild);
  deleteEntry('elsewhere', 'staff', 'member', 'other-channel');
  deleteEntry('other-author', 'staff', 'someone', 'channel');
  assert.equal((await resolveMessageDeleter(deleted(guild, 'mine', 'member'), fast)).source, 'self');
});

test('bots and Cloudy deleting their own messages are named, with the right type', async () => {
  const { guild } = auditGuild('bot-guild');
  await prime(guild);
  assert.deepEqual(await resolveMessageDeleter(deleted(guild, 'bot-own', 'bot-helper'), fast),
    { id: 'bot-helper', label: '<@bot-helper>', source: 'self', type: DELETION_TYPES.bot });
  assert.equal((await resolveMessageDeleter(deleted(guild, 'cloudy-own', 'cloudy'), fast)).type, DELETION_TYPES.cloudy);
});

test('Cloudy\'s own delete requests are attributed directly and do not hide a later self-deletion', async () => {
  const { guild, state, deleteEntry } = auditGuild('recorder-guild');
  await prime(guild);
  const calls = [];
  const rest = {
    async delete(route) { calls.push(route); if (route.endsWith('/2999')) throw new Error('Unknown Message'); },
    async post(route, options) { calls.push(route); return options; },
  };
  assert.equal(installCloudyDeletionRecorder(rest), true);
  await rest.delete('/channels/100/messages/2001');
  const readsBefore = state.reads;
  const result = await resolveMessageDeleter(deleted(guild, '2001', 'member'), fast);
  assert.deepEqual(result, { id: 'cloudy', label: '<@cloudy>', source: 'cloudy', type: DELETION_TYPES.cloudy });
  assert.equal(state.reads, readsBefore, 'no audit-log request for a deletion Cloudy made');
  // Cloudy's audit increment for that deletion must not be reused.
  deleteEntry('cloudy-entry', 'cloudy', 'member', 'channel');
  const own = await resolveMessageDeleter(deleted(guild, 'member-own', 'member'), fast);
  assert.equal(own.source, 'self');
  await assert.rejects(rest.delete('/channels/100/messages/2999'));
  assert.equal((await resolveMessageDeleter(deleted(guild, '2999', 'member'), fast)).source, 'self', 'a failed Cloudy delete is not Cloudy\'s');
  await rest.post('/channels/100/messages/bulk-delete', { body: { messages: ['3001', '3002'] } });
  const lookup = await resolveBulkDeletion(deleted(guild, '3001', 'member'), [deleted(guild, '3001', 'member'), deleted(guild, '3002', 'member')], { attemptDelaysMs: [0] });
  assert.equal(lookup(deleted(guild, '3002', 'member')).id, 'cloudy');
  assert.equal(lookup(deleted(guild, '3002', 'member')).type, DELETION_TYPES.bulk);
});

test('an AutoMod removal does not make the same author\'s next own deletion look like Cloudy', async () => {
  const { guild, deleteEntry } = auditGuild('automod-guild');
  await prime(guild);
  const automod = deleted(guild, 'automod-hit', 'member');
  rememberMessageDeleter(automod, client.user, 'automod');
  assert.equal((await resolveMessageDeleter(automod, fast)).source, 'automod');
  deleteEntry('automod-entry', 'cloudy', 'member', 'channel');
  assert.equal((await resolveMessageDeleter(deleted(guild, 'after', 'member'), fast)).source, 'self');
});

test('messages removed by a ban name the moderator who banned', async () => {
  const { guild, state } = auditGuild('ban-guild');
  await prime(guild);
  state.ban.push({ id: 'ban', executor: { id: 'mod' }, target: { id: 'member' }, createdTimestamp: Date.now() - 2_000 });
  assert.deepEqual(await resolveMessageDeleter(deleted(guild, 'banned-msg', 'member'), fast),
    { id: 'mod', label: '<@mod>', source: 'ban', type: DELETION_TYPES.ban });
});

test('without a baseline from before the deletion, or without audit access, nobody is named', async () => {
  const unprimed = auditGuild('unprimed-guild');
  assert.equal((await resolveMessageDeleter(deleted(unprimed.guild, 'early', 'member'), fast)).label, 'Unknown');
  const denied = auditGuild('denied-guild');
  await prime(denied.guild);
  denied.state.fail = true;
  assert.equal((await resolveMessageDeleter(deleted(denied.guild, 'denied', 'member'), fast)).label, 'Unknown');
  // A just-created entry is still evidence even without a baseline.
  const fresh = auditGuild('fresh-guild');
  fresh.deleteEntry('now', 'staff', 'member', 'channel');
  assert.equal((await resolveMessageDeleter(deleted(fresh.guild, 'fresh', 'member'), fast)).id, 'staff');
});

test('an uncached message with one matching audit entry learns its author from the entry', async () => {
  const { guild, deleteEntry } = auditGuild('partial-guild');
  await prime(guild);
  deleteEntry('partial', 'staff', 'member', 'channel');
  const result = await resolveMessageDeleter(deleted(guild, 'uncached', null, { partial: true }), fast);
  assert.equal(result.id, 'staff');
  assert.equal(result.authorId, 'member');
  // Never "self" for an unknown author.
  assert.equal((await resolveMessageDeleter(deleted(guild, 'uncached-2', null, { partial: true }), fast)).label, 'Unknown');
});

test('bulk deletions are resolved once; per-message intents keep the staff member', async () => {
  const { guild, state } = auditGuild('bulk-guild');
  state.bulk.push({ id: 'purge', executor: { id: 'mod' }, target: { id: 'channel' }, createdTimestamp: Date.now(), extra: { count: 2 } });
  const one = deleted(guild, 'bulk-one', 'member');
  const two = deleted(guild, 'bulk-two', 'member');
  rememberMessageDeleter(two, { id: 'purger' });
  const lookup = await resolveBulkDeletion(one, [one, two], { attemptDelaysMs: [0] });
  assert.deepEqual(lookup(one), { id: 'mod', label: '<@mod>', source: 'audit', type: DELETION_TYPES.bulk });
  assert.equal(lookup(two).id, 'purger');
  assert.equal(lookup(two).type, DELETION_TYPES.bulk);
});

test('staff deleting a member message routes to staff; author types are Staff/Bot/Member', () => {
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner' }, member = { id: 'member', permissions: new PermissionsBitField() };
  const staff = { id: 'staff', permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) };
  assert.equal(messageLogDestination(guild, 'member', member, {}, false, staff), OWNER_MOD_MESSAGE_LOG_ID);
  assert.deepEqual([messageLogAuthorType(guild, 'owner', null), messageLogAuthorType(guild, 'bot', null, {}, true), messageLogAuthorType(guild, 'member', member)], ['Staff', 'Bot', 'Member']);
});

test('bot action acknowledgements are excluded while actual bot content is logged', () => {
  const message = { client: { user: { id: 'cloudy' } }, author: { id: 'cloudy', bot: true }, embeds: [{ title: 'Report submitted' }] };
  assert.equal(isBotActionFeedback(message), true);
  assert.equal(isBotActionFeedback({ ...message, embeds: [{ title: 'Rust update', description: 'Actual published content' }] }), false);
  assert.equal(isBotActionFeedback({ ...message, author: { id: 'other-bot', bot: true } }), false);
});
