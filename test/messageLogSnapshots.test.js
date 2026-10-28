import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import messageUpdate from '../src/events/messageUpdate.js';
import brandingCreate from '../src/events/cloudyBrandingMessageCreate.js';
import { applyTemplatesToExistingMessage } from '../src/events/fullResponseCatalogReady.js';
import { primeSystemEmbedTemplateData } from '../src/services/systemEmbedCatalogService.js';
import {
  captureMessageSnapshot,
  clearMessageSnapshotMemory,
  getMessageSnapshot,
} from '../src/services/messageSnapshotService.js';
import { resetDeletionAttributionState } from '../src/services/deletionAttributionService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

function setup() {
  // Edit logs follow the guild's logging switch (deletion logs always run).
  const values = new Map([[`guild:${CLOUDY_GUILD_ID}:config`, { logging: { enabled: true } }]]);
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('member', { permissions: new PermissionsBitField() });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds[0].toJSON(), files: payload.files }); return { id: 'log' }; } });
  return { client, guild, sent };
}

test.beforeEach(() => { clearMessageSnapshotMemory(); resetDeletionAttributionState(); });

test('an uncached deleted message is logged from its stored copy: author, time, full text and media', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('photo bytes'), { headers: { 'content-type': 'image/png' } }));
  const { client, guild, sent } = setup();
  const created = 1_700_000_000_000;
  const original = {
    id: '1300000000000000001', guildId: guild.id, channelId: 'source', client, createdTimestamp: created,
    author: { id: 'member', bot: false }, content: 'the original text', embeds: [], stickers: new Collection(),
    attachments: new Collection([['a1', { id: 'a1', name: 'proof.png', url: 'https://cdn.discordapp.com/attachments/1/2/proof.png', contentType: 'image/png', size: 11 }]]),
  };
  await captureMessageSnapshot(original);
  assert.equal((await getMessageSnapshot(guild.id, original.id)).content, 'the original text');

  // After a restart Discord only sends the IDs.
  await logDeletedMessage({ id: original.id, guild, guildId: guild.id, channelId: 'source', client, partial: true, author: null, content: null, attachments: new Collection() });
  const log = sent.at(-1);
  assert.equal(log.id, MEMBER_MESSAGE_LOG_ID);
  assert.match(log.embed.description, /\*\*Message author:\*\* <@member>/);
  assert.match(log.embed.description, new RegExp(`\\*\\*Message created:\\*\\* <t:${Math.floor(created / 1000)}:f>`));
  assert.match(log.embed.description, /\*\*Channel:\*\* <#source>/);
  // Attachment names sit in the Message block; Message created is the last header line.
  assert.match(log.embed.description, /\*\*Message\*\*\nthe original text\n\n\*\*Attachments:\*\* 1 \(proof\.png\)/);
  assert.deepEqual(log.embed.description.split('\n').filter(line => line.startsWith('> ')).map(line => line.match(/^> \*\*([^:]+):/)[1]),
    ['Deleted by', 'Type', 'Channel', 'Message ID', 'Message author', 'Message created']);
  assert.match(log.embed.description, /\*\*Message\*\*\nthe original text/);
  assert.doesNotMatch(log.embed.description, /not cached/);
  assert.deepEqual(log.files.map(file => file.name), ['proof.png']);
  // The stored copy is removed once the deletion is logged.
  assert.equal(await getMessageSnapshot(guild.id, original.id), null);
});

test('without any stored copy the creation time still comes from the message ID', async () => {
  const { client, guild, sent } = setup();
  await logDeletedMessage({ id: '1300000000000000002', guild, guildId: guild.id, channelId: 'source', client, partial: true, author: null, content: null, attachments: new Collection() });
  const description = sent.at(-1).embed.description;
  assert.match(description, /\*\*Message created:\*\* <t:\d+:f>/);
  assert.match(description, /not cached before deletion/);
});

test('message logs and Cloudy status replies are never stored', async () => {
  const { client, guild } = setup();
  assert.equal(await captureMessageSnapshot({ id: '1', guildId: guild.id, channelId: MEMBER_MESSAGE_LOG_ID, client, author: { id: 'bot', bot: true }, content: 'log', embeds: [], attachments: new Collection() }), false);
  assert.equal(await captureMessageSnapshot({ id: '2', guildId: guild.id, channelId: 'source', client, author: { id: 'bot', bot: true }, content: '', embeds: [{ title: 'Success' }], attachments: new Collection() }), false);
});

test('edit logs use the stored "before", one channel mention, and skip link-preview updates', async () => {
  const { client, guild, sent } = setup();
  const base = { id: '1300000000000000003', guild, guildId: guild.id, channelId: 'source', client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'member', bot: false }, embeds: [], stickers: new Collection(), attachments: new Collection() };
  await captureMessageSnapshot({ ...base, content: 'before text' });
  await messageUpdate.execute({ id: base.id, partial: true, content: null }, { ...base, content: 'after text', editedTimestamp: Date.now() });
  const log = sent.at(-1);
  assert.equal(log.embed.title, 'Message edited');
  assert.match(log.embed.description, /\*\*Channel:\*\* <#source>/);
  assert.doesNotMatch(log.embed.description, /general/);
  assert.match(log.embed.description, /\*\*Message created:\*\* <t:1700000000:f>/);
  assert.deepEqual(log.embed.fields.map(field => [field.name, field.value]), [['Before', 'before text'], ['After', 'after text']]);
  // The snapshot now holds the edited text.
  assert.equal((await getMessageSnapshot(guild.id, base.id)).content, 'after text');

  const count = sent.length;
  // Discord adding a link preview to an uncached, unedited message is not an edit.
  await messageUpdate.execute({ id: '1300000000000000004', partial: true, content: null }, { ...base, id: '1300000000000000004', content: 'https://example.com', editedTimestamp: null });
  // Same content as stored: not an edit either.
  await messageUpdate.execute({ id: base.id, partial: true, content: null }, { ...base, content: 'after text', editedTimestamp: Date.now() });
  assert.equal(sent.length, count);
});

test('the generic branding listener never edits Staff/Member/AutoMod message logs after sending', async () => {
  setup();
  const edits = [];
  const message = channelId => ({ id: '9', guildId: CLOUDY_GUILD_ID, channelId, client: { user: { id: 'bot' } }, author: { id: 'bot' },
    flags: { has: () => false }, editable: true, deletable: false, content: '', components: [],
    embeds: [{ title: 'Message deleted', toJSON() { return { title: 'Message deleted' }; } }],
    edit: async payload => { edits.push(channelId); return payload; } });
  await brandingCreate.execute(message(MEMBER_MESSAGE_LOG_ID));
  await brandingCreate.execute(message(OWNER_MOD_MESSAGE_LOG_ID));
  assert.deepEqual(edits, []);
  // Control: the same embed elsewhere still receives the generic footer pass.
  await brandingCreate.execute(message('some-other-channel'));
  assert.deepEqual(edits, ['some-other-channel']);
});

test('message logs stay discoverable in Embed Builder Search as one entry for the newest log', async () => {
  const { getEmbedRegistry } = await import('../src/services/embedRegistryService.js');
  const { buildIndexedAutocompleteMatches, buildSearchChoices } = await import('../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js');
  setup();
  const channel = { id: MEMBER_MESSAGE_LOG_ID, name: 'member-message-logs', permissionsFor: () => ({ has: () => true }) };
  const guild = { id: CLOUDY_GUILD_ID, channels: { cache: new Map([[channel.id, channel]]) } };
  const log = id => {
    const data = { title: 'Message deleted', description: '> **Deleted by:** <@member>\n> **Type:** Deleted by author\n> **Channel:** <#source>', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } };
    return { id, guildId: guild.id, guild, channelId: channel.id, channel, client: { user: { id: 'bot' } }, author: { id: 'bot' },
      flags: { has: () => false }, editable: true, deletable: false, content: '', components: [],
      createdAt: new Date(), embeds: [{ ...data, toJSON() { return data; } }], edit: async () => { throw new Error('a message log must not be edited'); } };
  };
  await brandingCreate.execute(log('1300000000000000101'));
  await brandingCreate.execute(log('1300000000000000102'));
  // One registry row per log type and channel: the newest log, not one row
  // per deleted message.
  let rows = (await getEmbedRegistry(guild.id)).filter(row => row.title === 'Message deleted');
  assert.deepEqual(rows.map(row => row.messageId), ['1300000000000000102']);
  const choices = buildSearchChoices(buildIndexedAutocompleteMatches(guild, { id: 'owner' }, rows, 'message deleted'));
  assert.deepEqual(choices.map(choice => choice.name), ['Message deleted']);
  assert.match(choices[0].value, /1300000000000000102/);

  // A log the owner explicitly Saved in the Builder is never pruned.
  const { registerCloudyEmbedMessage } = await import('../src/services/embedRegistryService.js');
  await registerCloudyEmbedMessage(log('1300000000000000102'), 'automatic', { manualSave: true, manualSaveIndex: 0 });
  await brandingCreate.execute(log('1300000000000000103'));
  rows = (await getEmbedRegistry(guild.id)).filter(row => row.title === 'Message deleted');
  assert.deepEqual(rows.map(row => [row.messageId, row.manualSaved]).sort(), [['1300000000000000102', true], ['1300000000000000103', false]]);
});

test('the response-catalog pass never edits Staff/Member/AutoMod message logs after sending', async () => {
  setup();
  // A catalog template captured from an older log (different colour/footer).
  assert.equal(primeSystemEmbedTemplateData('message deleted', 'staff-message-logs',
    { title: 'Message deleted', color: 0x123456, footer: { text: 'Old footer' } }, CLOUDY_GUILD_ID), true);
  const edits = [];
  const message = channelId => ({ id: '1300000000000000201', guildId: CLOUDY_GUILD_ID, channelId,
    channel: { id: channelId, name: 'staff-message-logs' }, client: { user: { id: 'bot' } },
    author: { id: 'bot' }, editable: true, content: '', components: [],
    embeds: [{ title: 'Message deleted', description: '> **Deleted by:** <@member>', color: 0xFFFFFF }],
    edit: async payload => { edits.push(channelId); return payload; } });
  for (const channelId of [MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID]) {
    assert.equal(await applyTemplatesToExistingMessage(message(channelId), { initialCreation: true }), false);
  }
  assert.deepEqual(edits, []);
  // Control: the same message anywhere else is still rewritten by that pass.
  assert.equal(await applyTemplatesToExistingMessage(message('some-other-channel'), { initialCreation: true }), true);
  assert.deepEqual(edits, ['some-other-channel']);
});
