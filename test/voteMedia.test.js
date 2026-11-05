import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { freshVotePictureLinks, uploadVotePictures } from '../src/services/voteMediaService.js';

function setup() {
  const store = new Map();
  const created = [];
  const posts = [];
  const thread = {
    id: 'thread-1', locked: false,
    send: async payload => {
      posts.push(payload);
      return { id: `m${posts.length}`, attachments: new Collection(payload.files.map((file, index) => [String(index), {
        name: file.name, url: `https://cdn.discordapp.com/attachments/thread-1/m${posts.length}/${file.name}?ex=1`,
      }])) };
    },
    messages: { fetch: async () => ({ attachments: new Collection([['0', { name: 'option1.png', url: 'https://cdn.discordapp.com/fresh/option1.png?ex=9' }]]) }) },
  };
  const botlog = { id: 'botlog', name: 'botlog', type: ChannelType.GuildText, isTextBased: () => true,
    threads: { create: async options => { created.push(options); return thread; } } };
  const guild = { id: 'g1', channels: { cache: new Collection([[botlog.id, botlog]]) } };
  const client = {
    db: { get: async (key, fallback = null) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } },
    channels: { fetch: async id => (id === thread.id ? thread : null) },
  };
  return { client, guild, created, posts };
}

test('vote pictures go to one private vote-media thread in #botlog and give Discord picture links', async () => {
  const s = setup();
  const files = [{ attachment: Buffer.from('a'), name: 'option1.png' }, null, { attachment: Buffer.from('c'), name: 'option3.jpg' }];
  const result = await uploadVotePictures(s.client, s.guild, null, files);
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].type, ChannelType.PrivateThread);
  assert.equal(s.created[0].name, 'vote-media');
  assert.deepEqual(result.links, [
    'https://cdn.discordapp.com/attachments/thread-1/m1/option1.png?ex=1', null,
    'https://cdn.discordapp.com/attachments/thread-1/m1/option3.jpg?ex=1',
  ]);
  assert.deepEqual(result.media, { channelId: 'thread-1', messageId: 'm1', names: ['option1.png', null, 'option3.jpg'] });
  // The same thread is used again.
  await uploadVotePictures(s.client, s.guild, null, [files[0]]);
  assert.equal(s.created.length, 1);
  assert.equal(s.posts.length, 2);
  assert.deepEqual(await freshVotePictureLinks(s.client, result.media), ['https://cdn.discordapp.com/fresh/option1.png?ex=9', null, null]);
});
