import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import messageCreate from '../src/events/messageCreate.js';
import { isCloudyFeedPost, withCloudyFeedNonce } from '../src/utils/cloudyFeedPosts.js';

test('a Cloudy Feed post carries a feed nonce; only Cloudy can make a feed post', () => {
  const payload = withCloudyFeedNonce({ files: ['video'], allowedMentions: { parse: [] } });
  assert.deepEqual(payload.files, ['video']);
  assert.match(payload.nonce, /^cfeed/);
  assert.ok(payload.nonce.length <= 25);
  const client = { user: { id: 'cloudy' } };
  assert.equal(isCloudyFeedPost({ client, author: { id: 'cloudy' }, nonce: payload.nonce }), true);
  assert.equal(isCloudyFeedPost({ client, author: { id: 'member' }, nonce: payload.nonce }), false);
  assert.equal(isCloudyFeedPost({ client, author: { id: 'cloudy' }, nonce: 'cbld123' }), false);
  assert.equal(isCloudyFeedPost({ client, author: { id: 'cloudy' } }), false);
});

test('a Cloudy Feed photo/video counts for Reappear like a member post; other Cloudy messages do not', async () => {
  const guildId = '1632882647838299911';
  const channelId = '1654538622672599911';
  const ruleKey = `cloudy:embed-reappear:${guildId}:${channelId}:original`;
  const values = new Map([
    [`cloudy:embed-reappear-index:${guildId}:${channelId}`, ['original']],
    [ruleKey, { every: 5, count: 0, messageId: 'old', embed: { title: 'NSFW rules' }, components: [] }],
  ]);
  const storage = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key),
  };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;

  const client = { user: { id: 'cloudy' } };
  const guild = { id: guildId };
  const channel = { id: channelId, name: 'nsfw', messages: { fetch: async () => null } };
  const message = extra => ({ id: String(Math.random()), guild, channel, client, author: { id: 'cloudy', bot: true }, content: '', ...extra });

  await messageCreate.execute(message({ nonce: withCloudyFeedNonce({}).nonce }), client);
  assert.equal(values.get(ruleKey).count, 1, 'the feed post moved the Reappear counter on');

  // Reappear's own moved copy and other Cloudy messages never count.
  await messageCreate.execute(message({ nonce: 'cbld1234' }), client);
  await messageCreate.execute(message({}), client);
  assert.equal(values.get(ruleKey).count, 1);
});

test('a member photo post without text also counts for Reappear', async () => {
  const { Collection, PermissionsBitField } = await import('discord.js');
  const guildId = '1632882647838299921';
  const channelId = '1654538622672599921';
  const ruleKey = `cloudy:embed-reappear:${guildId}:${channelId}:original`;
  const values = new Map([
    [`cloudy:embed-reappear-index:${guildId}:${channelId}`, ['original']],
    [ruleKey, { every: 5, count: 0, messageId: 'old', embed: { title: 'NSFW rules' }, components: [] }],
  ]);
  db.db = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key),
  };
  const client = { user: { id: 'cloudy' }, commands: new Collection() };
  const guild = { id: guildId, ownerId: 'owner', members: { cache: new Collection() }, channels: { cache: new Collection() }, roles: { cache: new Collection() } };
  const channel = { id: channelId, name: 'nsfw', nsfw: true, messages: { fetch: async () => null } };
  const photo = { id: 'a1', name: 'photo.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', size: 10 };
  await messageCreate.execute({
    id: '1300000000000000901', guild, guildId, channel, channelId, client, content: '', embeds: [], stickers: new Collection(),
    author: { id: 'member', bot: false, username: 'member' },
    member: { id: 'member', permissions: new PermissionsBitField(), roles: { cache: new Collection() } },
    attachments: new Collection([['a1', photo]]),
  }, client);
  assert.equal(values.get(ruleKey).count, 1);
});
