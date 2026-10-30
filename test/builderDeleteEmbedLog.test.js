import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import { rememberMessageDeleter, resetDeletionAttributionState, AUTOMOD_LOG_CHANNEL_ID } from '../src/services/deletionAttributionService.js';
import { clearMessageSnapshotMemory } from '../src/services/messageSnapshotService.js';
import { CLOUDY_GUILD_ID, EMBED_LOG_CHANNEL_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

function setup() {
  const values = new Map([[`guild:${CLOUDY_GUILD_ID}:config`, { logging: { enabled: true } }]]);
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('staffer', { id: 'staffer', user: { id: 'staffer' }, permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageMessages) });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID, EMBED_LOG_CHANNEL_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds[0].toJSON(), copies: payload.embeds.slice(1), files: payload.files || [] }); return { id: 'log' }; } });
  return { client, guild, sent };
}

test.beforeEach(() => { clearMessageSnapshotMemory(); resetDeletionAttributionState(); });

test('an embed deleted with the Embed Builder is logged in the Embed log, by the staff member', async () => {
  const { client, guild, sent } = setup();
  const embed = { id: '1300000000000000501', guild, guildId: guild.id, channelId: 'rules', client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'bot', bot: true }, content: '', embeds: [{ title: 'Server rules', description: 'Be kind.' }],
    stickers: new Collection(), attachments: new Collection() };
  rememberMessageDeleter(embed, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(embed);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, EMBED_LOG_CHANNEL_ID);
  assert.match(sent[0].embed.description, /\*\*Deleted by:\*\* <@staffer>/);
  assert.match(sent[0].embed.description, /\*\*Type:\*\* Staff/);
  // The deleted embed itself is shown under the log details.
  assert.equal(sent[0].copies[0].title, 'Server rules');
  assert.equal(sent[0].copies[0].description, 'Be kind.');

  // The same embed deleted by a staff member in Discord is embed-related too:
  // it goes to the Embed log as well, never the AutoMod log.
  const manual = { ...embed, id: '1300000000000000502' };
  rememberMessageDeleter(manual, { id: 'staffer' });
  await logDeletedMessage(manual);
  assert.equal(sent[1].id, EMBED_LOG_CHANNEL_ID);
  assert.ok(!sent.some(entry => entry.id === AUTOMOD_LOG_CHANNEL_ID));
});

test('every message the Builder Delete removes is tagged as an Embed Builder deletion', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const start = source.indexOf('async function savePendingBuilderDeletionUnlocked(');
  const body = source.slice(start, source.indexOf('\nasync function ', start + 10));
  for (const target of ['logPresence.message', 'activeMessage', 'presence.message']) {
    const tag = body.indexOf(`rememberMessageDeleter(${target}, buttonInteraction.user, 'embed-builder')`);
    const deletion = body.indexOf(target === 'activeMessage' ? 'activeMessage?.delete?.()' : `await ${target}.delete()`);
    assert.ok(tag > 0 && deletion > tag, `${target} is tagged before it is deleted`);
  }
});

test('the Builder Delete log shows the deleted embed itself: colour bar, banner, fields and footer, without its text twice', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('banner bytes'), { headers: { 'content-type': 'image/png' } }));
  const { client, guild, sent } = setup();
  const bannerUrl = 'https://cdn.discordapp.com/attachments/1555000000000000000/1555000000000000999/banner.png?ex=1&is=2';
  const embed = {
    type: 'rich', title: 'Server rules', description: 'Be kind.', color: 0x8E44AD,
    fields: [{ name: 'Rule 1', value: 'No spam', inline: false }],
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.\u200B' },
    image: { url: bannerUrl, proxy_url: 'https://media.discordapp.net/x', width: 1200, height: 400 },
    thumbnail: { url: 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif' },
  };
  const message = { id: '1300000000000000511', guild, guildId: guild.id, channelId: 'rules', client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'bot', bot: true }, content: '', embeds: [{ toJSON: () => structuredClone(embed) }], stickers: new Collection(),
    attachments: new Collection([['1555000000000000999', { id: '1555000000000000999', name: 'banner.png', url: bannerUrl, contentType: 'image/png', size: 12 }]]) };
  rememberMessageDeleter(message, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(message);

  const log = sent.at(-1);
  assert.equal(log.id, EMBED_LOG_CHANNEL_ID);
  assert.equal(log.copies.length, 1);
  const copy = log.copies[0];
  assert.equal(copy.color, 0x8E44AD, 'the side colour is kept exactly');
  assert.equal(copy.image.url, 'attachment://banner.png', 'the banner is the copy uploaded with the log');
  assert.equal(copy.thumbnail.url, embed.thumbnail.url);
  assert.deepEqual(copy.fields, [{ name: 'Rule 1', value: 'No spam', inline: false }]);
  assert.equal(copy.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.', 'no Builder marker in a log');
  assert.equal(copy.type, undefined);
  assert.deepEqual(log.files.map(file => file.name), ['banner.png']);
  // The log details stay; the text is not repeated and the banner is not shown twice.
  assert.match(log.embed.description, /\*\*Deleted by:\*\* <@staffer>/);
  assert.doesNotMatch(log.embed.description, /Be kind\./);
  assert.equal(log.embed.image, undefined);
});

test('a deleted embed too long to show under the log keeps the normal text log', async () => {
  const { client, guild, sent } = setup();
  const message = { id: '1300000000000000512', guild, guildId: guild.id, channelId: 'rules', client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'bot', bot: true }, content: '', embeds: [{ title: 'Long', description: 'x'.repeat(4096), fields: [{ name: 'More', value: 'y'.repeat(1000) }] }],
    stickers: new Collection(), attachments: new Collection() };
  rememberMessageDeleter(message, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(message);
  assert.equal(sent.at(-1).copies.length, 0);
  assert.match(sent.at(-1).embed.description, /\*\*Message\*\*\nLong/);
});

test('only the log itself is a Search item in a message log channel, never the embed shown under it', async () => {
  setup();
  const { registerCloudyEmbedMessage, getEmbedRegistry } = await import('../src/services/embedRegistryService.js');
  const logData = { title: 'Message deleted', description: '> **Deleted by:** <@staffer>', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } };
  const copyData = { title: 'Server rules', description: 'Be kind.', color: 0x8E44AD };
  const channel = { id: AUTOMOD_LOG_CHANNEL_ID, name: 'automod-logs' };
  const message = { id: '1300000000000000513', guildId: CLOUDY_GUILD_ID, channelId: channel.id, channel, client: { user: { id: 'bot' } }, author: { id: 'bot' },
    flags: { has: () => false }, content: '', components: [], createdAt: new Date(),
    embeds: [{ ...logData, toJSON: () => logData }, { ...copyData, toJSON: () => copyData }] };
  await registerCloudyEmbedMessage(message, 'automatic');
  const rows = (await getEmbedRegistry(CLOUDY_GUILD_ID)).filter(row => String(row.messageId) === message.id);
  assert.deepEqual(rows.map(row => [row.embedIndex, row.title]), [[0, 'Message deleted']]);
});
