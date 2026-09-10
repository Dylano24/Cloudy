import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getGuildConfigKey,
  getGuildBirthdaysKey,
  getBirthdayLeftBackupKey,
  getBirthdayTrackingKey,
  getTicketKey,
  getTicketCounterKey,
  getInviteTrackingKey,
  getMemberInvitesKey,
  getInviteUsesKey,
  getFakeAccountKey,
  getEconomyKey,
  getEconomyPrefix,
  getAFKKey,
  getWelcomeConfigKey,
  getLevelingKey,
  getUserLevelKey,
  getUserLevelPrefix,
  getApplicationRolesKey,
  getApplicationSettingsKey,
  getUserApplicationsKey,
  getApplicationKey,
  getApplicationsPrefix,
  getJoinToCreateConfigKey,
  getJoinToCreateChannelsKey,
  getWarningsKey,
  getWarningsPrefix,
  getUserNotesKey,
  getUserNotesListKey,
  getReactionRoleKey,
  getReactionRolesPrefix,
  getServerCountersKey,
} from '../src/utils/database/keys.js';

const GUILD_A = '100000000000000001';
const GUILD_B = '100000000000000002';
const USER = '200000000000000001';
const CHANNEL = '300000000000000001';
const MESSAGE = '400000000000000001';
const INVITE = 'cloudy-test';
const APPLICATION = 'application-1';

const guildScopedBuilders = [
  ['guild config', guild => getGuildConfigKey(guild)],
  ['birthdays', guild => getGuildBirthdaysKey(guild)],
  ['birthday left backup', guild => getBirthdayLeftBackupKey(guild)],
  ['birthday tracking', guild => getBirthdayTrackingKey(guild)],
  ['ticket', guild => getTicketKey(guild, CHANNEL)],
  ['ticket counter', guild => getTicketCounterKey(guild)],
  ['invite tracking', guild => getInviteTrackingKey(guild)],
  ['member invites', guild => getMemberInvitesKey(guild, USER)],
  ['invite uses', guild => getInviteUsesKey(guild, INVITE)],
  ['fake account', guild => getFakeAccountKey(guild, USER)],
  ['economy', guild => getEconomyKey(guild, USER)],
  ['economy prefix', guild => getEconomyPrefix(guild)],
  ['afk', guild => getAFKKey(guild, USER)],
  ['welcome', guild => getWelcomeConfigKey(guild)],
  ['leveling', guild => getLevelingKey(guild)],
  ['user level', guild => getUserLevelKey(guild, USER)],
  ['user level prefix', guild => getUserLevelPrefix(guild)],
  ['application roles', guild => getApplicationRolesKey(guild)],
  ['application settings', guild => getApplicationSettingsKey(guild)],
  ['user applications', guild => getUserApplicationsKey(guild, USER)],
  ['application', guild => getApplicationKey(guild, APPLICATION)],
  ['applications prefix', guild => getApplicationsPrefix(guild)],
  ['join to create config', guild => getJoinToCreateConfigKey(guild)],
  ['join to create channels', guild => getJoinToCreateChannelsKey(guild)],
  ['warnings', guild => getWarningsKey(guild, USER)],
  ['warnings prefix', guild => getWarningsPrefix(guild)],
  ['user notes', guild => getUserNotesKey(guild, USER)],
  ['user notes list', guild => getUserNotesListKey(guild)],
  ['reaction role', guild => getReactionRoleKey(guild, MESSAGE)],
  ['reaction roles prefix', guild => getReactionRolesPrefix(guild)],
  ['server counters', guild => getServerCountersKey(guild)],
];

test('commercial tenant data builders isolate identical resources between guilds', () => {
  for (const [name, build] of guildScopedBuilders) {
    const left = build(GUILD_A);
    const right = build(GUILD_B);
    assert.notEqual(left, right, `${name} must not collide across guilds`);
    assert.ok(left.startsWith(`guild:${GUILD_A}:`), `${name} must use guild A namespace`);
    assert.ok(right.startsWith(`guild:${GUILD_B}:`), `${name} must use guild B namespace`);
  }
});

test('response catalog startup has one event-level synchronization owner', async () => {
  const eventsDir = path.resolve('src/events');
  const files = (await readdir(eventsDir)).filter(file => file.endsWith('.js'));
  let invocationCount = 0;

  for (const file of files) {
    const source = await readFile(path.join(eventsDir, file), 'utf8');
    invocationCount += source.match(/ensureSystemEmbedCatalogs\(client\)/g)?.length || 0;
  }

  assert.equal(invocationCount, 1, 'response catalog startup must not run duplicate full synchronization passes');
});

test('music keeps the existing UI while enabling Riffy node migration and reconnect hardening', async () => {
  const source = await readFile(path.resolve('src/services/music/riffySetup.js'), 'utf8');
  assert.match(source, /migrateOnDisconnect:\s*true/);
  assert.match(source, /migrateOnFailure:\s*true/);
  assert.match(source, /reconnectTimeout:\s*3000/);
  assert.match(source, /reconnectTries:\s*8/);
});
