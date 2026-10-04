import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { buildCloudyPublicKnowledgeEvidence } from '../src/services/cloudyPublicKnowledgeService.js';

test('FAQ links voice/forum/category channels and active threads with fresh member access checks', async () => {
  const member = { id: 'member', fresh: true }, bot = { id: 'bot' };
  const reads = [], lookups = [];
  const makeChannel = (id, text, allowed = true) => ({
    id, name: id, type: text ? 0 : 2,
    permissionsFor: actor => ({ has: permission => actor === bot || (actor === member && allowed
      && (permission === PermissionFlagsBits.ViewChannel || text)) }),
    ...(text ? { messages: { fetch: async () => {
      reads.push(id);
      return new Collection([[id, { id, content: `${id} rules`, createdTimestamp: 1 }]]);
    } } } : {}),
  });
  const channels = new Collection(['voice', 'forum', 'category'].map(id => [id, makeChannel(id, false)]));
  channels.set('text', makeChannel('text', true));
  const active = new Collection([['thread', makeChannel('thread', true)], ['private-thread', makeChannel('private-thread', true, false)]]);
  const guild = {
    id: 'guild', channels: { cache: channels, fetch: async id => id ? null : channels, fetchActiveThreads: async () => ({ threads: active }) },
    members: { me: bot, fetch: async options => { lookups.push(options); return member; } },
  };
  const client = { channels: guild.channels };
  const result = await buildCloudyPublicKnowledgeEvidence({ client, guild, user: member, member: { id: 'member', stale: true } }, { question: 'rules' });
  const payload = JSON.parse(result.text);
  assert.deepEqual(lookups, [{ user: 'member', force: true }]);
  assert.deepEqual(payload.readableChannelDirectory.map(channel => channel.channelId), ['voice', 'forum', 'category', 'text', 'thread']);
  assert.deepEqual(reads, ['text', 'thread']);
  assert.equal(result.channels, 2);
  assert.equal(payload.readablePublicChannelMessages.some(message => message.channelId === 'thread'), true);
  assert.equal(JSON.stringify(payload).includes('private-thread'), false);
});
