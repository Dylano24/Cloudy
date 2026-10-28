import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import {
  installCloudyDeletionRecorder,
  primeDeletionAuditBaseline,
  rememberMessageDeleter,
  resetDeletionAttributionState,
} from '../src/services/deletionAttributionService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

function setup({ failVideoUpload = false } = {}) {
  const values = new Map();
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'cloudy' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    // An audit log with no other-person deletions: own deletions are provable.
    fetchAuditLogs: async () => ({ entries: new Collection() }),
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('member', { id: 'member', user: { id: 'member', bot: false }, permissions: new PermissionsBitField() });
  guild.members.cache.set('mod', { id: 'mod', user: { id: 'mod', bot: false }, permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) });
  guild.members.cache.set('cloudy', { id: 'cloudy', user: { id: 'cloudy', bot: true }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      const files = payload.files || [];
      if (failVideoUpload && !payload.embeds && files.some(file => file.name.endsWith('.mp4'))) throw new Error('Request entity too large');
      sent.push({ id, payload, embed: payload.embeds?.[0]?.toJSON?.() || null, files });
      return { id: `log-${sent.length}`, attachments: new Collection(files.map((file, index) => [String(index),
        { name: file.name, url: `https://cdn.discordapp.com/attachments/${id}/${index}/${file.name}?ex=1` }])) };
    } });
  const message = (id, authorId, extra = {}) => ({ id, guild, guildId: guild.id, client, channelId: 'source',
    channel: { id: 'source', name: 'general' }, createdTimestamp: 1_700_000_000_000,
    author: { id: authorId, bot: false }, content: `text from ${authorId}`, embeds: [], attachments: new Collection(), ...extra });
  return { client, guild, sent, message };
}

const typeLine = embed => embed.description.match(/\*\*Type:\*\* (\w+)/)?.[1];

test.beforeEach(() => resetDeletionAttributionState());

test('Type names the one who deleted the message: Staff, Bot, or Member only for an own deletion', async () => {
  const { client, guild, sent, message } = setup();
  await primeDeletionAuditBaseline(guild);
  await new Promise(resolve => { setTimeout(resolve, 5); });

  // Staff removes a member's message.
  const byStaff = message('1300000000000000401', 'member');
  rememberMessageDeleter(byStaff, { id: 'mod', bot: false });
  await logDeletedMessage(byStaff);
  assert.equal(typeLine(sent.at(-1).embed), 'Staff');
  assert.match(sent.at(-1).embed.description, /\*\*Message author:\*\* <@member>/);

  // Cloudy (a bot) removes a member's message.
  const rest = { async delete() {} };
  installCloudyDeletionRecorder(rest);
  await rest.delete('/channels/1/messages/1300000000000000402');
  await logDeletedMessage(message('1300000000000000402', 'member'));
  assert.equal(typeLine(sent.at(-1).embed), 'Bot');

  // AutoMod is Cloudy too.
  const automod = message('1300000000000000403', 'member');
  rememberMessageDeleter(automod, client.user, 'automod');
  await logDeletedMessage(automod);

  // A member deleting their own message is Member; staff deleting their own is Staff.
  sent.length = 0;
  await Promise.all([
    logDeletedMessage(message('1300000000000000404', 'member')),
    logDeletedMessage(message('1300000000000000405', 'mod')),
  ]);
  const byAuthor = Object.fromEntries(sent.map(entry => [entry.embed.description.match(/Message author:\*\* <@(\w+)>/)[1], typeLine(entry.embed)]));
  assert.deepEqual(byAuthor, { member: 'Member', mod: 'Staff' });
  assert.ok(sent.every(entry => !/Author type/.test(entry.embed.description)));
});

test('a deleted video is sent just above the log and linked inside the embed, without editing the log', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(Buffer.from(url.endsWith('.mp4') ? 'video bytes' : 'photo bytes'),
    { headers: { 'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'image/png' } }));
  const { sent, message } = setup();
  const deleted = message('1300000000000000501', 'member', { content: '', attachments: new Collection([
    ['p', { id: 'p', name: 'photo.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/photo.png' }],
    ['v', { id: 'v', name: 'clip.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' }],
  ]) });
  rememberMessageDeleter(deleted, { id: 'mod' });
  await logDeletedMessage(deleted);

  assert.equal(sent.length, 2);
  // 1. The video on its own, so Discord gives it a lasting link.
  assert.equal(sent[0].embed, null);
  assert.deepEqual(sent[0].files.map(file => file.name), ['clip.mp4']);
  // 2. The log: photo inside the embed, video as a clickable link.
  const log = sent[1];
  assert.deepEqual(log.files.map(file => file.name), ['photo.png']);
  assert.equal(log.embed.image.url, 'attachment://photo.png');
  // Staff deleted it, so both go to the staff log, video directly above.
  assert.deepEqual(sent.map(entry => entry.id), [OWNER_MOD_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID]);
  assert.deepEqual(log.embed.fields, [{
    name: 'Video',
    value: `[clip.mp4](https://cdn.discordapp.com/attachments/${OWNER_MOD_MESSAGE_LOG_ID}/0/clip.mp4?ex=1)`,
  }]);
  assert.match(log.embed.description, /\*\*Message created:\*\* <t:1700000000:f>\n\n\*\*Message\*\*\n\*\*Attachments:\*\* 2/);
});

test('if the separate video upload fails, the video stays attached to the log itself', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('video bytes'), { headers: { 'content-type': 'video/mp4' } }));
  const { sent, message } = setup({ failVideoUpload: true });
  const deleted = message('1300000000000000601', 'member', { attachments: new Collection([
    ['v', { id: 'v', name: 'clip.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' }],
  ]) });
  rememberMessageDeleter(deleted, { id: 'mod' });
  await logDeletedMessage(deleted);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].files.map(file => file.name), ['clip.mp4']);
  assert.equal(sent[0].embed.fields, undefined);
});
