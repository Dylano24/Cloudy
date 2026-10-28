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
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds?.[0]?.toJSON?.() || null, files: payload.files, allowedMentions: payload.allowedMentions });
      return { id: 'log', attachments: new Collection((payload.files || []).map((file, index) => [String(index), { name: file.name, url: `https://cdn.discordapp.com/attachments/${id}/${index}/${file.name}` }])) }; } });
  const message = (id, extra = {}) => ({ id: `message-${id}`, guild, guildId: guild.id, client,
    author: { id, bot: id === 'bot', toString: () => `<@${id}>` }, createdTimestamp: 1000,
    content: `deleted text from ${id}`, channelId: 'source', channel: { id: 'source', name: 'general', toString: () => '<#source>' }, attachments: new Collection(), ...extra });
  await logDeletedMessage(message('owner'));
  await logDeletedMessage(message('mod'));
  await logDeletedMessage(message('member'));
  await logDeletedMessage(message('bot', { content: '', embeds: [{ title: 'Bot embed', description: 'Original bot content' }] }));
  assert.deepEqual(sent.map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID]);
  // No audit log here, so who deleted these cannot be verified: Type follows
  // the deleter, never the author.
  for (const index of [0, 1, 2, 3]) {
    assert.match(sent[index].embed.description, /\*\*Deleted by:\*\* Unknown\n> \*\*Type:\*\* Unknown$/m);
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
  // The video goes just above the log (Discord does not play video in bot
  // embeds) and is linked inside it; the photo is shown inside the embed.
  assert.equal(sent.at(-2).embed, null);
  assert.deepEqual(sent.at(-2).files.map(file => [file.name, file.attachment.toString()]), [['video.mp4', 'video bytes']]);
  assert.deepEqual(sent.at(-1).files.map(file => [file.name, file.attachment.toString()]), [['photo.png', 'photo bytes']]);
  assert.equal(sent.at(-1).embed.image?.url, 'attachment://photo.png');
  assert.equal(sent.at(-1).embed.fields[0].value, `[video.mp4](https://cdn.discordapp.com/attachments/${MEMBER_MESSAGE_LOG_ID}/0/video.mp4)`);
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
  // Type is the remover: AutoMod is Cloudy, a bot.
  assert.match(sent.at(-1).embed.description, /\*\*Type:\*\* Bot/);
  assert.doesNotMatch(sent.at(-1).embed.description, /Author type|Removed by AutoMod/);
  assert.match(JSON.stringify(sent.at(-1).embed), /Message author.*<@member>/s);
  const count = sent.length;
  await logDeletedMessage(message('bot', { channelId: MEMBER_MESSAGE_LOG_ID }));
  assert.equal(sent.length, count);
});
