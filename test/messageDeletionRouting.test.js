import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import { rememberMessageDeleter, AUTOMOD_LOG_CHANNEL_ID } from '../src/services/deletionAttributionService.js';
import bulkDelete from '../src/events/messageDeleteBulk.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

test('deleted human, moderator and bot messages route by author, including bulk and uncached messages', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(Buffer.from(url.includes('video') ? 'video bytes' : 'photo bytes'), { headers: { 'content-type': url.includes('video') ? 'video/mp4' : 'image/png' } }));
  const values = new Map([[`guild:${CLOUDY_GUILD_ID}:config`, { ticketStaffRoleId: 'staff-role', logging: { enabled: false, enabledEvents: { 'message.*': false, 'message.delete': false }, ignore: { users: ['member'], channels: ['source'] } } }]]);
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('mod', { permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) });
  guild.members.cache.set('bot', { user: { bot: true }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) });
  guild.members.cache.set('staff', { roles: { cache: new Collection([['staff-role', {}]]) } });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds[0].toJSON(), files: payload.files, allowedMentions: payload.allowedMentions }); return { id: 'log' }; } });
  const message = (id, extra = {}) => ({ id: `message-${id}`, guild, guildId: guild.id, client,
    author: { id, bot: id === 'bot', toString: () => `<@${id}>` }, createdTimestamp: 1000,
    content: `deleted text from ${id}`, channelId: 'source', channel: { id: 'source', name: 'general', toString: () => '<#source>' }, attachments: new Collection(), ...extra });
  await logDeletedMessage(message('owner'));
  await logDeletedMessage(message('mod'));
  await logDeletedMessage(message('member'));
  await logDeletedMessage(message('bot', { content: '', embeds: [{ title: 'Bot embed', description: 'Original bot content' }] }));
  assert.deepEqual(sent.map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID]);
  for (const [index, type] of ['Staff', 'Staff', 'Member', 'Bot'].entries()) {
    assert.match(sent[index].embed.description, new RegExp(`\\*\\*Type:\\*\\* ${type}$`, 'm'));
    assert.deepEqual(sent[index].allowedMentions, { parse: [] });
  }
  assert.match(JSON.stringify(sent.at(-1).embed), /Bot embed.*Original bot content/s);
  // Channel is one clickable mention (never "general #general"), created is
  // a full date/time, and every required field is present in order.
  const description = sent[2].embed.description;
  assert.match(description, /\*\*Channel:\*\* <#source>\n/);
  assert.doesNotMatch(description, /general/);
  assert.match(description, /\*\*Message created:\*\* <t:1:f>/);
  assert.deepEqual(description.split('\n').filter(line => line.startsWith('> ')).map(line => line.match(/^> \*\*([^:]+):/)[1]),
    ['Deleted by', 'Type', 'Channel', 'Message ID', 'Message author', 'Message created']);
  assert.doesNotMatch(description, /Author type/);
  // Footer is final when sent; the generic listener never edits these logs.
  assert.equal(sent[2].embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  await logDeletedMessage(message('member', { content: '', attachments: new Collection([
    ['photo', { name: 'photo.png', url: 'https://cdn.discordapp.com/attachments/one/photo.png', contentType: 'image/png' }],
    ['video', { name: 'video.mp4', url: 'https://cdn.discordapp.com/attachments/one/video.mp4', contentType: 'video/mp4' }],
  ]) }));
  assert.deepEqual(sent.at(-1).files.map(file => file.name), ['photo.png', 'video.mp4']);
  assert.deepEqual(sent.at(-1).files.map(file => file.attachment.toString()), ['photo bytes', 'video bytes']);
  // The photo is shown inside the embed (clickable there); the video stays a
  // playable attachment because Discord does not play video in bot embeds.
  assert.equal(sent.at(-1).embed.image?.url, 'attachment://photo.png');
  assert.equal(sent.at(-1).id, MEMBER_MESSAGE_LOG_ID);
  const destination = guild.channels.cache.get(MEMBER_MESSAGE_LOG_ID);
  const originalSend = destination.send;
  let failed = false;
  destination.send = async payload => {
    if (payload.files && !failed) { failed = true; throw Object.assign(new Error('Upload rejected'), { code: 40005 }); }
    return originalSend(payload);
  };
  await logDeletedMessage(message('member', { attachments: new Collection([
    ['photo', { name: 'photo.png', url: 'https://cdn.discordapp.com/attachments/one/photo.png', contentType: 'image/png' }],
  ]) }));
  assert.equal(failed, true);
  assert.equal(sent.at(-1).files, undefined);
  assert.match(JSON.stringify(sent.at(-1).embed), /deleted text from member/);
  // No upload, so no attachment:// image may be referenced.
  assert.equal(sent.at(-1).embed.image, undefined);
  destination.send = originalSend;
  await logDeletedMessage(message('staff', { content: 'x'.repeat(4000), channelId: 'different-channel', attachments: new Collection([['image', { url: 'https://cdn.example/image.png' }]]) }));
  assert.equal(sent.at(-1).id, OWNER_MOD_MESSAGE_LOG_ID);
  assert.match(sent.at(-1).files[0].attachment.toString(), /x{4000}.*https:\/\/cdn.example\/image.png/s);
  await bulkDelete.execute(new Collection([['one', message('owner')], ['two', message('member')]]));
  assert.deepEqual(sent.slice(-2).map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]);
  await logDeletedMessage(message('unknown', { author: null, partial: true, content: '', createdTimestamp: undefined }));
  assert.equal(sent.at(-1).id, MEMBER_MESSAGE_LOG_ID);
  assert.match(JSON.stringify(sent.at(-1).embed), /not cached/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).embed), /NaN/);
  const automatic = message('member', { id: 'automod-message' });
  rememberMessageDeleter(automatic, client.user, 'automod');
  await logDeletedMessage(automatic);
  assert.equal(sent.at(-1).id, AUTOMOD_LOG_CHANNEL_ID);
  assert.match(JSON.stringify(sent.at(-1).embed), /Deleted by.*<@bot>.*AutoMod/s);
  // The author is a member, even though AutoMod removed it.
  assert.match(sent.at(-1).embed.description, /\*\*Type:\*\* Member/);
  assert.doesNotMatch(sent.at(-1).embed.description, /Author type|Removed by AutoMod/);
  assert.match(JSON.stringify(sent.at(-1).embed), /Message author.*<@member>/s);
  const count = sent.length;
  await logDeletedMessage(message('bot', { channelId: MEMBER_MESSAGE_LOG_ID }));
  assert.equal(sent.length, count);
});
