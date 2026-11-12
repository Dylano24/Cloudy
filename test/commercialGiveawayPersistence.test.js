import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { postGiveaway, rerollGiveaway, removeGiveaway, finishGiveaway } from '../src/services/giveawayActions.js';

function fixture({ channel = null, stored = {} } = {}) {
  let logLookups = 0;
  const replies = [];
  const client = {
    db: { get: async () => structuredClone(stored), set: async () => false },
    channels: { fetch: async () => channel },
    guilds: { cache: new Collection(), fetch: async () => { logLookups++; return null; } },
  };
  const interaction = {
    id: 'giveaway-persistence', guildId: 'giveaway-persistence-guild', client,
    createdTimestamp: Date.now(), deferred: true, inGuild: () => true,
    user: { id: 'manager', tag: 'Manager' }, member: { permissions: { has: () => true } },
    guild: { id: 'giveaway-persistence-guild', channels: { cache: new Collection() } },
    editReply: async payload => { replies.push(payload); },
    options: { getString: () => '123456789012345678', getInteger: () => 1, getChannel: () => channel },
  };
  return { client, interaction, replies, logLookups: () => logLookups };
}

test('giveaway creation rolls back its posted panel and reports failure when its initial save is rejected', async () => {
  let deleted = 0;
  const channel = { id: 'target', name: 'giveaways', isTextBased: () => true,
    send: async () => ({ id: '123456789012345678', delete: async () => { deleted++; } }) };
  const f = fixture({ channel });
  let failure;
  await postGiveaway(f.client, f.interaction.guild, channel, { prize: 'Prize', durationMs: 3_600_000, winnerCount: 1, hostId: 'manager' })
    .catch(error => { failure = error; });
  assert.equal(f.replies.length, 0);
  assert.equal(f.logLookups(), 0);
  assert.equal(deleted, 1);
  assert.ok(failure, 'Rejected persistence must surface as failure');
});

for (const route of ['missing-channel', 'missing-message', 'existing-message']) {
  test(`giveaway reroll ${route} never announces or reports unsaved winners`, async () => {
    const giveaway = { messageId: '123456789012345678', channelId: 'target', prize: 'Prize', hostId: 'host', participants: ['winner'], winnerCount: 1, ended: true };
    let announcements = 0;
    const channel = route === 'missing-channel' ? null : {
      id: 'target', isTextBased: () => true,
      messages: { fetch: async () => route === 'missing-message' ? null : { edit: async () => { announcements++; } } },
      send: async () => { announcements++; return { id: 'winner-announcement' }; },
    };
    const f = fixture({ channel, stored: { [giveaway.messageId]: giveaway } });
    let failure;
    await rerollGiveaway(f.client, f.interaction.guild, giveaway.messageId, {rerolledBy: f.interaction.user.id}).catch(error => { failure = error; });
    assert.equal(f.replies.length, 0);
    assert.equal(announcements, 0);
    assert.equal(f.logLookups(), 0);
    assert.ok(failure, 'Rejected persistence must surface as failure');
  });
}

test('giveaway deletion reports failure when its database update is rejected', async () => {
  const giveaway = { messageId: '123456789012345678', channelId: 'target', prize: 'Prize' };
  const f = fixture({ stored: { [giveaway.messageId]: giveaway } });
  await assert.rejects(removeGiveaway(f.client, f.interaction.guild, giveaway.messageId, {deletedBy: f.interaction.user}), /Failed to delete giveaway from database/);
  assert.equal(f.replies.length, 0);
  assert.equal(f.logLookups(), 0);
});

// The draw is saved first (write 1). Before the winners are announced, Cloudy
// saves that the announcement is being sent (write 2), so winners can never be
// tagged twice; the announcement's ID and claim deadline follow (write 3).
for (const rejectedWrite of [1, 2, 3]) {
  test(`giveaway end stops before success when persistence write ${rejectedWrite} is rejected`, async () => {
    const giveaway = { messageId: '123456789012345678', channelId: 'target', prize: 'Prize', participants: ['winner'], winnerCount: 1 };
    let writes = 0;
    let announcements = 0;
    let edits = 0;
    let stored = { [giveaway.messageId]: giveaway };
    const channel = { id: 'target', isTextBased: () => true,
      messages: { fetch: async () => ({ edit: async () => { edits++; } }) },
      send: async () => { announcements++; return { id: 'winner-announcement' }; },
    };
    const f = fixture({ channel, stored });
    f.client.db.get = async () => structuredClone(stored);
    f.client.db.set = async (_key, value) => {
      if (++writes === rejectedWrite) return false;
      stored = structuredClone(value);
      return true;
    };
    let failure;
    await finishGiveaway(f.client, f.interaction.guild, giveaway.messageId, {endedBy: f.interaction.user.id}).catch(error => { failure = error; });
    assert.equal(f.replies.length, 0);
    assert.equal(f.logLookups(), 0);
    assert.equal(edits, rejectedWrite === 1 ? 0 : 1);
    // Winners are only ever tagged after "being announced" was saved.
    assert.equal(announcements, rejectedWrite === 3 ? 1 : 0);
    assert.ok(failure, 'Rejected persistence must surface as failure');
    const saved = stored[giveaway.messageId];
    if (rejectedWrite === 1) assert.notEqual(saved.ended, true, 'nothing was saved, so the giveaway is still open');
    // The saved draw is still waiting to be shown: the next check announces it.
    if (rejectedWrite === 2) assert.deepEqual(saved.resultPending, { kind: 'ended', winners: ['winner'], attempts: 0 });
    if (rejectedWrite === 3) assert.equal(saved.resultPending, undefined);
  });
}

// Owner's choice: a giveaway deleted with Manage > Delete is logged in the
// Embed log (with the deleted giveaway itself), like the Embed Builder's Delete.
test('giveaway Delete names the staff member and routes the removed messages to the Embed log', async () => {
  const { resolveMessageDeleter } = await import('../src/services/deletionAttributionService.js');
  const giveaway = { messageId: '123456789012345678', channelId: 'target', prize: 'Prize',
    announcementIds: ['123456789012345679'] };
  let stored = { [giveaway.messageId]: giveaway };
  const guild = { id: 'giveaway-persistence-guild', channels: { cache: new Collection() } };
  const removed = [];
  const message = id => ({ id, guild, channelId: 'target', client: { user: { id: 'cloudy' } },
    author: { id: 'cloudy', bot: true }, delete: async function() { removed.push(this); } });
  const channel = { id: 'target', isTextBased: () => true, messages: { fetch: async id => message(id) } };
  guild.channels.cache.set('target', channel);
  const client = {
    db: { get: async () => structuredClone(stored), set: async (key, value) => { stored = value; return true; } },
    channels: { fetch: async () => channel },
    guilds: { cache: new Collection(), fetch: async () => null },
  };
  await removeGiveaway(client, guild, giveaway.messageId, { deletedBy: { id: 'staff-1', bot: false } });
  assert.deepEqual(removed.map(entry => entry.id), [giveaway.messageId, '123456789012345679']);
  for (const entry of removed) {
    const deletedBy = await resolveMessageDeleter(entry, { authorId: 'cloudy', authorBot: true });
    assert.equal(deletedBy.source, 'embed-builder');
    assert.equal(deletedBy.id, 'staff-1');
  }
});
