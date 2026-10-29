import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import { rememberMessageDeleter, resetDeletionAttributionState, AUTOMOD_LOG_CHANNEL_ID } from '../src/services/deletionAttributionService.js';
import { clearMessageSnapshotMemory } from '../src/services/messageSnapshotService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';

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
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), send: async payload => { sent.push({ id, embed: payload.embeds[0].toJSON() }); return { id: 'log' }; } });
  return { client, guild, sent };
}

test.beforeEach(() => { clearMessageSnapshotMemory(); resetDeletionAttributionState(); });

test('an embed deleted with the Embed Builder is logged in the AutoMod log, by the staff member', async () => {
  const { client, guild, sent } = setup();
  const embed = { id: '1300000000000000501', guild, guildId: guild.id, channelId: 'rules', client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'bot', bot: true }, content: '', embeds: [{ title: 'Server rules', description: 'Be kind.' }],
    stickers: new Collection(), attachments: new Collection() };
  rememberMessageDeleter(embed, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(embed);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, AUTOMOD_LOG_CHANNEL_ID);
  assert.match(sent[0].embed.description, /\*\*Deleted by:\*\* <@staffer>/);
  assert.match(sent[0].embed.description, /\*\*Type:\*\* Staff/);
  assert.match(sent[0].embed.description, /Server rules/);

  // Control: the same embed deleted by a staff member in Discord stays in the Staff log.
  const manual = { ...embed, id: '1300000000000000502' };
  rememberMessageDeleter(manual, { id: 'staffer' });
  await logDeletedMessage(manual);
  assert.equal(sent[1].id, OWNER_MOD_MESSAGE_LOG_ID);
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
