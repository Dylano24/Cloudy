import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import { rememberMessageDeleter, resetDeletionAttributionState } from '../src/services/deletionAttributionService.js';
import { clearMessageSnapshotMemory } from '../src/services/messageSnapshotService.js';
import { CLOUDY_GUILD_ID, EMBED_LOG_CHANNEL_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';
import { buildGiveawayCreatedLog, buildGiveawayEndedLog } from '../src/services/giveawayLogService.js';
import { buildGiveawayClaimLog, GIVEAWAY_CLAIM_LOG_CHANNEL_ID, sendGiveawayClaimLog } from '../src/services/giveawayClaimLogService.js';
import { relinkDeletedGiveaway } from '../src/services/giveawayDeletedLogLinks.js';

const GUILD = CLOUDY_GUILD_ID;
const GIVEAWAY_CHANNEL = '1560000000000000003';
const DELETED = '1560000000000000022';
const OTHER = '1560000000000000023';
const LOGS = '1560000000000000040';
const WINNER = '1560000000000000005';
const giveawayUrl = id => `https://discord.com/channels/${GUILD}/${GIVEAWAY_CHANNEL}/${id}`;
const giveaway = id => ({ messageId: id, channelId: GIVEAWAY_CHANNEL, prize: 'Shjsjs', hostId: WINNER, winnerCount: 1,
  participants: [], createdAt: '2026-11-12T18:32:00.000Z', endedAt: '2026-11-12T18:33:00.000Z' });
const field = (embed, name) => embed.fields.find(item => item.name === name)?.value;

function logMessage(id, embed) {
  return { id, author: { id: 'bot' }, embeds: [embed], edits: [],
    edit: async function(payload) { this.edits.push(payload); this.embeds = payload.embeds; return this; } };
}

function textChannel(id, name, messages) {
  return { id, name, type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    send: async payload => payload,
    messages: { fetch: async () => new Collection(messages.map(message => [message.id, message])) } };
}

function setup() {
  const values = new Map([
    [`guild:${GUILD}:config`, { logging: { enabled: true } }],
    [`guild:${GUILD}:giveaway-log:numbers-v1`, { last: 23, numbers: { [DELETED]: 22, [OTHER]: 23 } }],
  ]);
  const storage = { get: async key => structuredClone(values.get(key) ?? null), set: async (key, value) => { values.set(key, structuredClone(value)); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'bot' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: GUILD, ownerId: 'owner', name: 'Cloudy', client,
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(GUILD, guild);
  guild.members.cache.set('staffer', { id: 'staffer', user: { id: 'staffer' }, permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageMessages) });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, EMBED_LOG_CHANNEL_ID]) guild.channels.cache.set(id, { id, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => { sent.push({ id, payload }); return { id: '1560000000000000900', url: `https://discord.com/channels/${GUILD}/${id}/1560000000000000900` }; } });

  const logs = {
    created: logMessage('1560000000000000101', buildGiveawayCreatedLog(GUILD, giveaway(DELETED), 22).embeds[0]),
    ended: logMessage('1560000000000000102', buildGiveawayEndedLog(GUILD, giveaway(DELETED), [], 22).embeds[0]),
    other: logMessage('1560000000000000103', buildGiveawayCreatedLog(GUILD, giveaway(OTHER), 23).embeds[0]),
  };
  const claim = (event, id) => buildGiveawayClaimLog({ event, guildId: GUILD, messageId: id, userId: WINNER,
    claimChannelId: '1560000000000000070', giveaway: giveaway(id), giveawayNumber: id === DELETED ? 22 : 23 }).embeds[0];
  const legacyClosed = claim('closed', DELETED);
  legacyClosed.fields = legacyClosed.fields.map(item => item.name === 'Giveaway' ? { ...item, value: '#22' } : item);
  const claims = {
    opened: logMessage('1560000000000000201', claim('opened', DELETED)),
    legacyClosed: logMessage('1560000000000000202', legacyClosed),
    other: logMessage('1560000000000000203', claim('opened', OTHER)),
    unrelated: logMessage('1560000000000000204', { title: 'Other log', fields: [{ name: 'Giveaway', value: '#22' }] }),
  };
  const claimChannel = textChannel(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, 'giveaway-claim-logs', Object.values(claims));
  claimChannel.send = async payload => { claimChannel.sent = payload; return payload; };
  guild.channels.cache.set(LOGS, textChannel(LOGS, 'giveaway-logs', Object.values(logs)));
  guild.channels.cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, claimChannel);
  return { client, guild, sent, logs, claims, claimChannel };
}

test.beforeEach(() => { clearMessageSnapshotMemory(); resetDeletionAttributionState(); });

test('only the Giveaway field of a log of the deleted giveaway is relinked', () => {
  const url = `https://discord.com/channels/${GUILD}/${EMBED_LOG_CHANNEL_ID}/1560000000000000900`;
  const options = { guildId: GUILD, messageId: DELETED, number: 22, url };
  const created = buildGiveawayCreatedLog(GUILD, giveaway(DELETED), 22).embeds[0];
  const result = relinkDeletedGiveaway(created, options);
  assert.equal(result.changed, true);
  assert.equal(field(result.embed, 'Giveaway'), `[#22](${url})`);
  assert.deepEqual(result.embed.fields.filter(item => item.name !== 'Giveaway'), created.fields.filter(item => item.name !== 'Giveaway'));
  assert.equal(result.embed.color, created.color);
  assert.equal(relinkDeletedGiveaway(buildGiveawayCreatedLog(GUILD, giveaway(OTHER), 23).embeds[0], options).changed, false);
  assert.equal(relinkDeletedGiveaway({ title: 'Other log', fields: [{ name: 'Giveaway', value: '#22' }] }, options).changed, false);
});

test('a giveaway deleted with Manage > Delete: every #N of it opens its Embed log entry, also on later claim logs', async () => {
  const { client, guild, sent, logs, claims, claimChannel } = setup();
  const deleted = { id: DELETED, guild, guildId: GUILD, channelId: GIVEAWAY_CHANNEL, client, createdTimestamp: 1_700_000_000_000,
    author: { id: 'bot', bot: true }, content: '', embeds: [{ title: 'Giveaway time !', description: 'Shjsjs' }],
    stickers: new Collection(), attachments: new Collection() };
  rememberMessageDeleter(deleted, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(deleted);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, EMBED_LOG_CHANNEL_ID);
  const url = `https://discord.com/channels/${GUILD}/${EMBED_LOG_CHANNEL_ID}/1560000000000000900`;

  for (const entry of [logs.created, logs.ended, claims.opened, claims.legacyClosed]) {
    assert.equal(entry.edits.length, 1);
    assert.equal(field(entry.embeds[0], 'Giveaway'), `[#22](${url})`);
  }
  assert.equal(logs.created.embeds[0].color, 0xFFFFFF, 'nothing else changes');
  assert.equal(field(claims.opened.embeds[0], 'Claimed by'), `<@${WINNER}>`);
  for (const entry of [logs.other, claims.other, claims.unrelated]) assert.equal(entry.edits.length, 0);
  assert.equal(field(logs.other.embeds[0], 'Giveaway'), `[#23](${giveawayUrl(OTHER)})`);

  // A claim of the deleted giveaway that closes afterwards links there too.
  await sendGiveawayClaimLog(client, guild, { event: 'closed', messageId: DELETED, userId: WINNER,
    claimChannelId: '1560000000000000070', giveaway: giveaway(DELETED) });
  assert.equal(field(claimChannel.sent.embeds[0], 'Giveaway'), `[#22](${url})`);
  // A message that never was a giveaway changes nothing.
  sent.length = 0;
  const plain = { ...deleted, id: '1560000000000000999', embeds: [{ title: 'Server rules', description: 'Be kind.' }] };
  rememberMessageDeleter(plain, { id: 'staffer' }, 'embed-builder');
  await logDeletedMessage(plain);
  assert.equal(sent.length, 1);
  assert.equal(logs.other.edits.length, 0);
});
