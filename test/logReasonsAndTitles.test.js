import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { logDeletedMessage } from '../src/events/messageDelete.js';
import memberUpdate from '../src/events/guildMemberUpdate.js';
import {
  AUTOMOD_LOG_CHANNEL_ID,
  primeDeletionAuditBaseline,
  rememberMessageDeleter,
  resetDeletionAttributionState,
} from '../src/services/deletionAttributionService.js';
import { CLOUDY_GUILD_ID, MEMBER_MESSAGE_LOG_ID, OWNER_MOD_MESSAGE_LOG_ID } from '../src/services/messageLogDestination.js';
import { automodReasonText, REPORTED_MESSAGE_REASON } from '../src/utils/automodReason.js';

const TIMEOUT_LOG_CHANNEL_ID = '1539371111240831078';

function setup({ guildId = CLOUDY_GUILD_ID, auditEntries = [] } = {}) {
  const values = new Map();
  const storage = { get: async key => values.get(key) || null, set: async (key, value) => { values.set(key, value); return true; }, delete: async key => values.delete(key) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: 'cloudy' }, db: storage, guilds: { cache: new Collection() } };
  const guild = { id: guildId, ownerId: 'owner', name: 'Cloudy', client,
    fetchAuditLogs: async () => ({ entries: new Collection(auditEntries.map((entry, index) => [String(index), entry])) }),
    members: { me: {}, cache: new Collection(), fetch: async id => guild.members.cache.get(id) || null },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null }, iconURL: () => null };
  client.guilds.cache.set(guild.id, guild);
  guild.members.cache.set('member', { id: 'member', user: { id: 'member', bot: false }, permissions: new PermissionsBitField() });
  guild.members.cache.set('mod', { id: 'mod', user: { id: 'mod', bot: false }, permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) });
  guild.members.cache.set('cloudy', { id: 'cloudy', user: { id: 'cloudy', bot: true }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) });
  const sent = [];
  for (const id of [OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, AUTOMOD_LOG_CHANNEL_ID, TIMEOUT_LOG_CHANNEL_ID]) {
    guild.channels.cache.set(id, { id, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
      send: async payload => { sent.push({ id, embed: payload.embeds?.[0]?.toJSON?.() || null }); return { id: `log-${sent.length}` }; } });
  }
  const message = (id, authorId) => ({ id, guild, guildId: guild.id, client, channelId: 'source',
    channel: { id: 'source', name: 'general' }, createdTimestamp: 1_700_000_000_000,
    author: { id: authorId, bot: false }, content: `text from ${authorId}`, embeds: [], attachments: new Collection() });
  return { client, guild, sent, message };
}

const labels = description => [...description.matchAll(/\*\*([^*]+):\*\*/g)].map(match => match[1]);
const line = (description, name) => new RegExp(`\\*\\*${name}:\\*\\* ([^\\n]+)`).exec(description)?.[1];

test.beforeEach(() => resetDeletionAttributionState());

test('an AutoMod reason reads "Message spam detected (AutoMod)"', () => {
  assert.equal(automodReasonText('Automod: message spam detected'), 'Message spam detected (AutoMod)');
  assert.equal(automodReasonText('Automatic protection: link spam'), 'Link spam (AutoMod)');
  assert.equal(automodReasonText(''), 'AutoMod');
});

test('AutoMod deletion: Deleted by is only Cloudy Manager, the reason carries (AutoMod)', async () => {
  const { client, guild, sent, message } = setup();
  await primeDeletionAuditBaseline(guild);
  const spam = message('1300000000000000901', 'member');
  rememberMessageDeleter(spam, client.user, 'automod', { reason: automodReasonText('Automod: message spam detected') });
  await logDeletedMessage(spam);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, AUTOMOD_LOG_CHANNEL_ID);
  const { description } = sent[0].embed;
  assert.equal(line(description, 'Deleted by'), '<@cloudy>');
  assert.equal(line(description, 'Reason'), 'Message spam detected (AutoMod)');
  assert.deepEqual(labels(description),
    ['Deleted by', 'Type', 'Reason', 'Channel', 'Message ID', 'Message author', 'Message created']);
});

test('a message deleted because of a report has the reason "Reported message" in the Staff log', async () => {
  const { guild, sent, message } = setup();
  await primeDeletionAuditBaseline(guild);
  const reported = message('1300000000000000902', 'member');
  rememberMessageDeleter(reported, { id: 'mod', bot: false }, 'staff', { reason: REPORTED_MESSAGE_REASON });
  await logDeletedMessage(reported);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, OWNER_MOD_MESSAGE_LOG_ID);
  const { description } = sent[0].embed;
  assert.equal(line(description, 'Deleted by'), '<@mod>');
  assert.equal(line(description, 'Reason'), 'Reported message');
  assert.equal(labels(description).at(-1), 'Message created');
});

test('a normal deletion has no Reason line', async () => {
  const { guild, sent, message } = setup();
  await primeDeletionAuditBaseline(guild);
  const plain = message('1300000000000000903', 'member');
  rememberMessageDeleter(plain, { id: 'mod', bot: false });
  await logDeletedMessage(plain);
  assert.equal(line(sent[0].embed.description, 'Reason'), undefined);
});

async function timeoutLog(t, { userId, executorId, reason }) {
  const { client, guild, sent } = setup({ guildId: 'other-guild', auditEntries: [] });
  guild.fetchAuditLogs = async () => ({ entries: new Collection([['1', {
    target: { id: userId }, createdTimestamp: Date.now(), reason,
    executor: { id: executorId, tag: executorId, toString: () => `<@${executorId}>` },
  }]]) });
  const user = { id: userId, tag: userId, toString: () => `<@${userId}>`, displayAvatarURL: () => null };
  const member = timeout => ({ id: userId, guild, client, user, nickname: null, communicationDisabledUntilTimestamp: timeout });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = memberUpdate.execute(member(0), member(Date.now() + 10 * 60_000));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(750);
  t.mock.timers.reset();
  await running;
  return sent;
}

test('AutoMod timeout log is titled "Auto timeout" with the reason "Message spam detected (AutoMod)"', async t => {
  const sent = await timeoutLog(t, { userId: 'spammer', executorId: 'cloudy', reason: 'Automod: message spam detected' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, AUTOMOD_LOG_CHANNEL_ID, 'AutoMod timeouts stay in the AutoMod log');
  assert.equal(sent[0].embed.title, 'Auto timeout');
  assert.equal(line(sent[0].embed.description, 'Reason'), 'Message spam detected (AutoMod)');
});

test('a staff timeout log is titled "Timeout" and keeps its own reason', async t => {
  const sent = await timeoutLog(t, { userId: 'rulebreaker', executorId: 'mod', reason: 'Being rude' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, TIMEOUT_LOG_CHANNEL_ID);
  assert.equal(sent[0].embed.title, 'Timeout');
  assert.equal(line(sent[0].embed.description, 'Reason'), 'Being rude');
});
