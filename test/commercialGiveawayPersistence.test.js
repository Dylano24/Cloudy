import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import create from '../src/commands/Giveaway/gcreate.js';
import reroll from '../src/commands/Giveaway/greroll.js';
import remove from '../src/commands/Giveaway/gdelete.js';
import end from '../src/commands/Giveaway/gend.js';

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
  f.interaction.options.getString = name => name === 'duration' ? '1h' : 'Prize';
  let failure;
  await create.execute(f.interaction).catch(error => { failure = error; });
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
    await reroll.execute(f.interaction).catch(error => { failure = error; });
    assert.equal(f.replies.length, 0);
    assert.equal(announcements, 0);
    assert.equal(f.logLookups(), 0);
    assert.ok(failure, 'Rejected persistence must surface as failure');
  });
}

test('giveaway deletion reports failure when its database update is rejected', async () => {
  const giveaway = { messageId: '123456789012345678', channelId: 'target', prize: 'Prize' };
  const f = fixture({ stored: { [giveaway.messageId]: giveaway } });
  await assert.rejects(remove.execute(f.interaction), /Failed to delete giveaway from database/);
  assert.equal(f.replies.length, 0);
  assert.equal(f.logLookups(), 0);
});

for (const rejectedWrite of [1, 2]) {
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
    await end.execute(f.interaction).catch(error => { failure = error; });
    assert.equal(f.replies.length, 0);
    assert.equal(f.logLookups(), 0);
    assert.equal(edits, rejectedWrite === 1 ? 0 : 1);
    assert.equal(announcements, rejectedWrite === 1 ? 0 : 1);
    assert.ok(failure, 'Rejected persistence must surface as failure');
  });
}
