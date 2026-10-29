import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import {
  installCloudyDeletionRecorder,
  primeDeletionAuditBaseline,
  rememberMessageDeleter,
  resetDeletionAttributionState,
} from '../src/services/deletionAttributionService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

function setup() {
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

test('a deleted video is hosted on Cloudy\'s own page and linked in the log; nothing is shown above the log', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudy-deleted-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.test';
  t.after(() => { delete process.env.CLOUDY_EMBED_MEDIA_DIR; delete process.env.CLOUDY_EMBED_MEDIA_BASE_URL; });
  t.mock.method(globalThis, 'fetch', async url => new Response(Buffer.from(url.endsWith('.mov') ? 'video bytes' : 'photo bytes'),
    { headers: { 'content-type': url.endsWith('.mov') ? 'video/quicktime' : 'image/png' } }));
  const { sent, message } = setup();
  const deleted = message('1300000000000000501', 'member', { content: '', attachments: new Collection([
    ['p', { id: 'p', name: 'photo.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/photo.png' }],
    ['v', { id: 'v', name: 'clip.mov', contentType: 'video/quicktime', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mov' }],
  ]) });
  rememberMessageDeleter(deleted, { id: 'mod' });
  await logDeletedMessage(deleted);

  // One Discord message: the log. The video is not uploaded to Discord.
  assert.equal(sent.length, 1);
  const log = sent[0];
  assert.deepEqual(log.files.map(file => file.name), ['photo.png']);
  assert.equal(log.embed.image.url, 'attachment://photo.png');
  assert.equal(log.embed.fields.length, 1);
  assert.equal(log.embed.fields[0].name, 'Video');
  const link = log.embed.fields[0].value.match(/^\[clip\.mov\]\((https:\/\/cloudy\.test\/deleted-media\/([A-Za-z0-9_-]{32}))\)$/);
  assert.ok(link, log.embed.fields[0].value);
  // The hosted copy is exactly the deleted video.
  assert.equal((await readFile(join(dir, 'deleted-media', link[2] + '.video'))).toString(), 'video bytes');
  assert.match(log.embed.description, /\*\*Attachments:\*\* 2 \(photo\.png, clip\.mov\)/);
});

test('without video storage the video stays attached to the log itself (never lost)', async t => {
  delete process.env.CLOUDY_EMBED_MEDIA_DIR;
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('video bytes'), { headers: { 'content-type': 'video/mp4' } }));
  const { sent, message } = setup();
  const deleted = message('1300000000000000601', 'member', { attachments: new Collection([
    ['v', { id: 'v', name: 'clip.mp4', contentType: 'video/mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4' }],
  ]) });
  rememberMessageDeleter(deleted, { id: 'mod' });
  await logDeletedMessage(deleted);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].files.map(file => file.name), ['clip.mp4']);
  assert.equal(sent[0].embed.fields, undefined);
});

test('Cloudy\'s private replies are never logged as an unknown, uncached deletion', async () => {
  const { guild, sent, message } = setup();
  await primeDeletionAuditBaseline(guild);
  const rest = {
    async delete() {},
    async post(route) {
      // A private follow-up (the Builder channel picker / "Message sent").
      if (String(route).startsWith('/webhooks/')) return { id: '1300000000000000501', flags: 64 };
      // A public reply returned by an interaction callback.
      return { resource: { message: { id: '1300000000000000503', flags: 0 } } };
    },
    async patch() { return { id: '1300000000000000504', flags: 64 }; },
    async get() { return { id: '1300000000000000505', flags: 64 }; },
  };
  installCloudyDeletionRecorder(rest);
  await rest.post('/webhooks/1534506224312389863/token');
  await rest.post('/interactions/1/token/callback');
  await rest.patch('/webhooks/1534506224312389863/token/messages/@original');
  await rest.get('/webhooks/1534506224312389863/token/messages/@original');
  // Deleted by its own interaction link (removed after 10 seconds).
  await rest.delete('/webhooks/1534506224312389863/token/messages/1300000000000000502');

  // Discord reports these deletions without content or author (never cached).
  const uncached = id => ({ id, guild, guildId: guild.id, client: guild.client, channelId: 'source',
    channel: { id: 'source', name: 'general' }, partial: true, author: null, content: null,
    embeds: [], attachments: new Collection() });
  sent.length = 0;
  for (const id of ['1300000000000000501', '1300000000000000502', '1300000000000000504', '1300000000000000505']) {
    await logDeletedMessage(uncached(id), { snapshot: null });
  }
  assert.equal(sent.length, 0, 'no "Unknown / not cached" log for Cloudy\'s own private replies');

  // A public reply is not marked by this rule, and a member's message is still logged.
  await logDeletedMessage(message('1300000000000000506', 'member'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].embed.description, /\*\*Message author:\*\* <@member>/);
});
