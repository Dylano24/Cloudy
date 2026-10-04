import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import bulkDelete from '../src/events/messageDeleteBulk.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

test('deleted human, moderator and bot messages route by author, including bulk and uncached messages', async () => {
  const values = new Map([[`guild:${CLOUDY_GUILD_ID}:config`, { logging: { enabled: true } }]]);
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('mod', { permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) });
  guild.members.cache.set('bot', { user: { bot: true }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds[0].toJSON() }); return { id: 'log' }; } });
  const message = (id, extra = {}) => ({ id: `message-${id}`, guild, guildId: guild.id, client,
    author: { id, bot: id === 'bot', toString: () => `<@${id}>` }, createdTimestamp: 1000,
    content: `deleted text from ${id}`, channelId: 'source', channel: { id: 'source', name: 'general', toString: () => '<#source>' }, attachments: new Collection(), ...extra });
  await logDeletedMessage(message('owner'));
  await logDeletedMessage(message('mod'));
  await logDeletedMessage(message('member'));
  await logDeletedMessage(message('bot', { content: '', embeds: [{ title: 'Bot embed', description: 'Original bot content' }] }));
  assert.deepEqual(sent.map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]);
  assert.match(JSON.stringify(sent.at(-1).embed), /Bot embed.*Original bot content/s);
  await bulkDelete.execute(new Collection([['one', message('owner')], ['two', message('member')]]));
  assert.deepEqual(sent.slice(-2).map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]);
  await logDeletedMessage(message('unknown', { author: null, partial: true, content: '', createdTimestamp: undefined }));
  assert.equal(sent.at(-1).id, MEMBER_MESSAGE_LOG_ID);
  assert.match(JSON.stringify(sent.at(-1).embed), /not cached/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).embed), /NaN/);
  const count = sent.length;
  await logDeletedMessage(message('bot', { channelId: MEMBER_MESSAGE_LOG_ID }));
  assert.equal(sent.length, count);
});
