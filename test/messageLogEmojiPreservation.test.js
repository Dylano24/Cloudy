import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import messageUpdate from '../src/events/messageUpdate.js';
import { captureMessageSnapshot, clearMessageSnapshotMemory } from '../src/services/messageSnapshotService.js';
import { resetDeletionAttributionState } from '../src/services/deletionAttributionService.js';
import {
  CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID, EMBED_LOG_CHANNEL_ID,
} from '../src/services/messageLogDestination.js';

const GUILD_ID = CLOUDY_GUILD_ID;
const CONTENT = 'Hi 🌈 👩‍💻 🏳️‍🌈 <:cloudy:156000000000000111> <a:party:156000000000000112>';

function fixture() {
  const values = new Map([[`guild:${GUILD_ID}:config`, { logging: { enabled: true } }]]);
  const store = {
    get: async (key, fallback) => structuredClone(values.get(key) ?? fallback),
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => { values.delete(key); return true; },
  };
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = store;
  const client = { user: { id: 'bot' }, db: store, guilds: { cache: new Collection() } };
  const sent = [];
  const guild = {
    id: GUILD_ID, name: 'Cloudy', client, ownerId: 'owner',
    members: {
      me: {}, cache: new Collection([['member', { id: 'member', permissions: new PermissionsBitField() }]]),
      fetch: async id => guild.members.cache.get(id) || null,
    },
    channels: {
      cache: new Collection(),
      fetch: async id => guild.channels.cache.get(id) || null,
    },
    iconURL: () => null,
  };
  client.guilds.cache.set(GUILD_ID, guild);
  for (const id of [MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID, EMBED_LOG_CHANNEL_ID]) {
    guild.channels.cache.set(id, {
      id, type: ChannelType.GuildText,
      permissionsFor: () => ({ has: () => true }),
      send: async payload => {
        sent.push({ channelId: id, embed: payload.embeds[0].toJSON() });
        return { id: String(156000000000000500n + BigInt(sent.length)) };
      },
    });
  }
  return { client, guild, sent };
}

test('Message Delete log retains real Unicode and custom/animated emoji even with a saved Builder template', async () => {
  clearMessageSnapshotMemory();
  resetDeletionAttributionState();
  const { client, guild, sent } = fixture();
  const saved = await saveEmbedTemplateDecoration(GUILD_ID, MEMBER_MESSAGE_LOG_ID,
    ['Message deleted'], {
      title: 'Message deleted', description: 'Owner-designed sample body, not the deleted content',
      color: 0x123456,
      fields: [{ name: 'Old', value: 'Static saved value', inline: false }],
    });
  assert.equal(saved, true);
  const original = {
    id: '156000000000000301', guild, guildId: guild.id, channelId: 'source', client,
    createdTimestamp: 1_700_000_000_000, author: { id: 'member', bot: false },
    content: CONTENT, embeds: [], attachments: new Collection(), stickers: new Collection(),
  };
  // A partial Discord deletion should use the original snapshot byte-for-byte.
  await captureMessageSnapshot(original);
  await logDeletedMessage({
    id: original.id, guild, guildId: guild.id, channelId: 'source', client,
    partial: true, author: null, content: null, embeds: [], attachments: new Collection(),
  });
  assert.equal(sent.length, 1);
  const actual = sent[0].embed;
  assert.equal(sent[0].channelId, MEMBER_MESSAGE_LOG_ID);
  assert.equal(actual.color, 0x123456);
  assert.ok(actual.description.includes('**Message**\n' + CONTENT));
  assert.ok(actual.description.includes('<:cloudy:156000000000000111>'));
  assert.ok(actual.description.includes('<a:party:156000000000000112>'));
  assert.ok(actual.description.includes('👩‍💻'));
  assert.ok(!actual.description.includes('Owner-designed sample body'));
  assert.deepEqual(actual.fields || [], []);
});

test('Message Edit log keeps before/after emoji content while allowing saved style', async () => {
  clearMessageSnapshotMemory();
  resetDeletionAttributionState();
  const { client, guild, sent } = fixture();
  const saved = await saveEmbedTemplateDecoration(GUILD_ID, MEMBER_MESSAGE_LOG_ID,
    ['Message edited'], {
      title: 'Message edited', description: 'Replace old message', color: 0x765432,
      fields: [{ name: 'Before', value: 'Wrong old', inline: true },
        { name: 'After', value: 'Wrong new', inline: true }],
    });
  assert.equal(saved, true);
  const base = {
    id: '156000000000000302', guild, guildId: guild.id, channelId: 'source', client,
    createdTimestamp: 1_700_000_000_000, author: { id: 'member', bot: false },
    embeds: [], stickers: new Collection(), attachments: new Collection(),
  };
  const oldText = 'Before 😀 <:cloudy:156000000000000111>';
  await messageUpdate.execute({ ...base, content: oldText },
    { ...base, content: CONTENT, editedTimestamp: Date.now() });
  assert.equal(sent.length, 1);
  const actual = sent[0].embed;
  assert.equal(actual.color, 0x765432);
  assert.ok(actual.description.includes('**Channel:** <#source>'));
  assert.deepEqual(actual.fields.map(field => [field.name, field.value]),
    [['Before', oldText], ['After', CONTENT]]);
  assert.ok(!actual.fields.some(field => field.value.includes('Wrong')));
});
