import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { addXp } from '../src/services/leveling/xpSystem.js';
import { getXpForLevel, saveUserLevelData } from '../src/services/leveling/leveling.js';
import messageCreate from '../src/events/messageCreate.js';
import { BotConfig } from '../src/config/bot.js';
import { logger } from '../src/utils/logger.js';

let fixtureNumber = 0;
const now = 1_800_000_000_000;

function fixture(options = {}) {
  const guildId = `leveling-concurrency-${++fixtureNumber}`;
  const userId = 'member';
  const levelKey = `guild:${guildId}:leveling:users:${userId}`;
  const state = { xp: 0, level: 0, totalXp: 0, lastMessage: 0, rank: 0, ...options.state };
  const config = { leveling: { enabled: true, xpCooldown: 20, xpRange: { min: 2, max: 2 },
    roleRewards: {}, announceLevelUp: false, ...options.config }, logging: { enabled: false } };
  const reads = [];
  const writes = [];
  const announcements = [];
  const roleAwards = [];
  const channel = { id: 'general', name: 'general', isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }), send: async text => { announcements.push(text); return {}; } };
  const guild = { id: guildId, name: 'Test guild', channels: { cache: new Collection([[channel.id, channel]]) },
    systemChannel: channel, members: { me: {} }, roles: { cache: new Collection([['reward', { id: 'reward', name: 'Reward' }]]) } };
  const member = { id: userId, user: { id: userId, tag: 'Member', bot: false }, guild,
    roles: { cache: new Collection(), add: async role => { roleAwards.push(role.id); } }, toString: () => `<@${userId}>` };
  const client = { user: { id: 'bot' }, guilds: { cache: new Collection([[guildId, guild]]) },
    db: { get: async key => {
      reads.push(key);
      return structuredClone(key === levelKey ? state : key === `guild:${guildId}:config` ? config : null);
    }, set: async (key, data) => {
      writes.push({ key, data: structuredClone(data) });
      if (options.rejectWrites) return false;
      Object.assign(state, structuredClone(data));
      return true;
    } } };
  const message = { guild, author: member.user, member, channel, content: 'hello', client };
  return { client, guild, member, message, state, reads, writes, levelKey, announcements, roleAwards };
}

function quiet(t) {
  t.mock.method(Date, 'now', () => now);
  for (const method of ['debug', 'info', 'error']) t.mock.method(logger, method, () => {});
}

test('simultaneous message awards apply the configured cooldown inside the member lock', async t => {
  quiet(t);
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 3 }, () =>
    addXp(f.client, f.guild, f.member, 2, { messageAward: true })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.state.totalXp, 2);
  assert.equal(f.state.lastMessage, now);
  assert.equal(f.writes.length, 1);
});

test('message cooldown allows the exact boundary and keeps the existing default', async t => {
  quiet(t);
  for (const [cooldown, milliseconds] of [[20, 20_000], [undefined, 60_000], [0, 60_000]]) {
    const blocked = fixture({ config: { xpCooldown: cooldown }, state: { lastMessage: now - milliseconds + 1 } });
    assert.equal(await addXp(blocked.client, blocked.guild, blocked.member, 2, { messageAward: true }), null);
    assert.equal(blocked.writes.length, 0);
    const allowed = fixture({ config: { xpCooldown: cooldown }, state: { lastMessage: now - milliseconds } });
    assert.ok(await addXp(allowed.client, allowed.guild, allowed.member, 2, { messageAward: true }));
    assert.equal(allowed.state.totalXp, 2);
  }
});

test('manual XP awards keep their existing behavior during the message cooldown', async t => {
  quiet(t);
  const f = fixture({ state: { lastMessage: now } });
  const results = await Promise.all([
    addXp(f.client, f.guild, f.member, 2),
    addXp(f.client, f.guild, f.member, 3),
  ]);
  assert.equal(results.filter(Boolean).length, 2);
  assert.equal(f.state.totalXp, 5);
  assert.equal(f.writes.length, 2);
});

test('the message event reads level state once per attempt and concurrent messages award once', async t => {
  quiet(t);
  const previous = BotConfig.features.leveling;
  BotConfig.features.leveling = true;
  t.after(() => { BotConfig.features.leveling = previous; });
  const f = fixture();
  await Promise.all([messageCreate.execute(f.message, f.client), messageCreate.execute(f.message, f.client)]);
  assert.equal(f.state.totalXp, 2);
  assert.equal(f.reads.filter(key => key === f.levelKey).length, 2);
  assert.equal(f.writes.length, 1);
});

test('rejected persistence throws and prevents level-up messages or role awards', async t => {
  quiet(t);
  const options = { rejectWrites: true, state: { xp: 49, totalXp: 49 },
    config: { announceLevelUp: true, roleRewards: { 1: 'reward' },
      levelUpMessage: '{user} has leveled up to level {level}!' } };
  const f = fixture(options);
  const logLookups = t.mock.method(f.client.guilds.cache, 'get');
  await assert.rejects(addXp(f.client, f.guild, f.member, 2, { messageAward: true }),
    error => error.name === 'TitanBotError' && error.type === 'database');
  assert.equal(f.state.totalXp, 49);
  assert.equal(f.announcements.length, 0);
  assert.equal(f.roleAwards.length, 0);
  assert.equal(logLookups.mock.callCount(), 0);
  await assert.rejects(saveUserLevelData(f.client, f.guild.id, f.member.id, f.state),
    error => error.name === 'TitanBotError' && error.type === 'database');
  options.rejectWrites = false;
  assert.ok(await addXp(f.client, f.guild, f.member, 2, { messageAward: true }));
  assert.equal(f.state.totalXp, 51);
  assert.deepEqual(f.roleAwards, ['reward']);
  assert.equal(f.announcements.length, 1);
});

test('successful level-up still awards the configured role and existing announcement after saving', async t => {
  quiet(t);
  const f = fixture({ state: { xp: 49, totalXp: 49 },
    config: { announceLevelUp: true, roleRewards: { 1: 'reward' },
      levelUpMessage: '{user} has leveled up to level {level}!' } });
  t.mock.method(f.member.roles, 'add', async role => {
    assert.equal(f.state.level, 1);
    f.roleAwards.push(role.id);
  });
  t.mock.method(f.guild.systemChannel, 'send', async text => {
    assert.equal(f.state.level, 1);
    f.announcements.push(text);
    return {};
  });
  const result = await addXp(f.client, f.guild, f.member, 2, { messageAward: true });
  assert.equal(result.leveledUp, true);
  assert.equal(f.state.level, 1);
  assert.equal(f.state.xp, 1);
  assert.deepEqual(f.roleAwards, ['reward']);
  assert.deepEqual(f.announcements, [`<@${f.member.id}> has leveled up to level 1!`]);
});

test('disabled leveling and invalid XP still skip without reading or writing user data', async t => {
  quiet(t);
  const disabled = fixture({ config: { enabled: false } });
  assert.equal(await addXp(disabled.client, disabled.guild, disabled.member, 2, { messageAward: true }), null);
  assert.equal(disabled.reads.includes(disabled.levelKey), false);
  const invalid = fixture();
  assert.equal(await addXp(invalid.client, invalid.guild, invalid.member, 0, { messageAward: true }), null);
  assert.equal(invalid.reads.length, 0);
  assert.equal(disabled.writes.length + invalid.writes.length, 0);
});

test('multiple level rewards retain ascending order with one final announcement', async t => {
  quiet(t);
  const f = fixture({ config: { announceLevelUp: true, roleRewards: { 1: 'reward', 2: 'second-reward' },
    levelUpMessage: '{user} has leveled up to level {level}!' } });
  f.guild.roles.cache.set('second-reward', { id: 'second-reward', name: 'Second reward' });
  const result = await addXp(f.client, f.guild, f.member, 155);
  assert.equal(result.level, 2);
  assert.deepEqual(f.roleAwards, ['reward', 'second-reward']);
  assert.deepEqual(f.announcements, [`<@${f.member.id}> has leveled up to level 2!`]);
});

test('reaching level 1000 persists the award and returns success without looking up level 1001', async t => {
  quiet(t);
  const f = fixture({ state: { level: 999, xp: getXpForLevel(999) - 1, totalXp: 12345 },
    config: { announceLevelUp: true, roleRewards: { 1000: 'reward' },
      levelUpMessage: 'Level {level}, XP needed {xpNeeded}' } });
  const result = await addXp(f.client, f.guild, f.member, 2);
  assert.equal(result.level, 1000);
  assert.equal(result.xp, 1);
  assert.equal(result.xpNeeded, getXpForLevel(1000));
  assert.equal(f.state.level, 1000);
  assert.equal(f.state.totalXp, 12347);
  assert.deepEqual(f.roleAwards, ['reward']);
  assert.deepEqual(f.announcements, [`Level 1000, XP needed ${getXpForLevel(1000)}`]);
  const atCap = await addXp(f.client, f.guild, f.member, 3);
  assert.equal(atCap.level, 1000);
  assert.equal(atCap.xp, 4);
  assert.equal(atCap.xpNeeded, getXpForLevel(1000));
  assert.equal(f.state.totalXp, 12350);
  assert.equal(f.roleAwards.length, 1);
  assert.equal(f.announcements.length, 1);
  assert.throws(() => getXpForLevel(1001), /Invalid level/);
});
