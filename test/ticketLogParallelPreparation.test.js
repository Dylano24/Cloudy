import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ChannelType, Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logTicketEvent } from '../src/utils/ticket/ticketLogging.js';

test('ticket log templates load while author lookup is pending, before one final styled send', async t => {
  const guildId = '1632882647838228899';
  const channelId = '1632882647838228898';
  const reads = [], sent = [];
  let releaseAuthor;
  const author = new Promise(resolve => { releaseAuthor = resolve; });
  t.after(() => releaseAuthor(null));
  const storage = { get: async key => {
    reads.push(key);
    if (key.includes('embed-template:')) return {
      'ticket created': { title: 'Saved ticket title', description: 'Saved body', schemaVersion: 3 },
    };
    return { ticketLogsChannelId: channelId };
  } };
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = storage;
  const client = { db: storage };
  const channel = { id: channelId, type: ChannelType.GuildText,
    isSendable: () => true, permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push(payload); },
  };
  const guild = { id: guildId, client,
    channels: { cache: new Collection([[channelId, channel]]) },
    members: { me: {}, cache: new Collection(), fetch: () => author },
  };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const pending = logTicketEvent({ client, guildId,
    event: { type: 'open', userId: '1632882647838228897', ticketId: channelId, ticketNumber: 8 },
  });
  await setImmediate();
  const templateReadsStarted = reads.filter(key => key.includes('embed-template:')).length;
  assert.equal(sent.length, 0);
  releaseAuthor({ user: { username: 'Creator', displayAvatarURL: () => 'https://example.com/avatar.png' } });
  assert.equal(await pending, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].toJSON().title, 'Saved ticket title');
  assert.equal(sent[0].embeds[0].toJSON().description, 'Saved body');
  assert.equal(templateReadsStarted, 2, 'both template scopes should load before the member fetch finishes');
  assert.equal(reads.filter(key => key.includes('embed-template:')).length, 2);
});
