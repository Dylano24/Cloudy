import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { logger } from '../src/utils/logger.js';

process.env.DISCORD_TOKEN ||= 'offline-test-token';
const { default: memberRemove } = await import('../src/events/guildMemberRemove.js');

function fixture(canSend = false) {
  const guildId = 'member-leave-security-guild';
  const userId = 'member-leave-user';
  const birthday = { month: 6, day: 4 };
  const keys = {
    welcome: `guild:${guildId}:welcome`, birthday: `guild:${guildId}:birthdays`,
    backup: `guild:${guildId}:birthdays:left`, level: `guild:${guildId}:leveling:users:${userId}`,
  };
  const stored = new Map([
    [keys.welcome, { goodbyeEnabled: true, goodbyeChannelId: 'goodbye' }],
    [keys.birthday, { [userId]: birthday }], [keys.level, { xp: 250 }],
  ]);
  const db = {
    get: async (key, fallback) => structuredClone(stored.get(key) ?? fallback),
    set: async (key, value) => { stored.set(key, structuredClone(value)); return true; },
    delete: async key => stored.delete(key),
  };
  let sent = 0;
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(canSend
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : []),
    send: async () => { sent++; },
  };
  const user = { id: userId, tag: 'LeftUser', toString: () => `<@${userId}>`, displayAvatarURL: () => 'https://example.com/avatar.png' };
  const client = { db, user: { id: 'bot' } };
  const guild = {
    id: guildId, name: 'Guild', memberCount: 1, client,
    channels: { cache: new Collection([['goodbye', channel]]) }, members: { me: { id: 'bot' } },
    fetchAuditLogs: async () => ({ entries: new Collection([['kick', { target: user, executor: client.user, createdTimestamp: Date.now() }]]) }),
  };
  return { member: { guild, user, client }, stored, keys, userId, birthday, sent: () => sent };
}

test('missing goodbye send permissions do not prevent departing-member data cleanup', async t => {
  t.mock.method(logger, 'error', () => {});
  t.mock.method(logger, 'warn', () => {});
  const f = fixture();
  await memberRemove.execute(f.member);
  assert.equal(f.sent(), 0);
  assert.deepEqual(f.stored.get(f.keys.backup), { [f.userId]: f.birthday });
  assert.deepEqual(f.stored.get(f.keys.birthday), {});
  assert.equal(f.stored.has(f.keys.level), false);
});

test('permitted goodbye delivery continues to clean up departing-member data', async t => {
  t.mock.method(logger, 'error', () => {});
  t.mock.method(logger, 'warn', () => {});
  const f = fixture(true);
  await memberRemove.execute(f.member);
  assert.equal(f.sent(), 1);
  assert.deepEqual(f.stored.get(f.keys.backup), { [f.userId]: f.birthday });
  assert.equal(f.stored.has(f.keys.level), false);
});
