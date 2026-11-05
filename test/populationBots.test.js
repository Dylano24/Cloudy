import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { POPULATION_ROLE_NAME, populationBotTokens, resetPopulationBots, updatePopulationBots } from '../src/services/populationBotService.js';

const TOKEN = 't'.repeat(40);

function setup({ inGuild = true } = {}) {
  const presences = [];
  const logins = [];
  const created = [];
  const roleIds = new Set();
  const role = { id: 'role1', name: POPULATION_ROLE_NAME };
  const guild = {
    roles: { cache: new Collection(), create: async options => { created.push(options); guild.roles.cache.set(role.id, role); return role; } },
    members: { fetch: async id => {
      if (!inGuild) throw new Error('Unknown Member');
      return { id, roles: { cache: { has: roleId => roleIds.has(roleId) }, add: async added => { roleIds.add(added.id); } } };
    } },
  };
  const createClient = () => ({
    login: async token => { logins.push(token); },
    user: { id: 'bot1', setPresence: value => presences.push(value) },
  });
  return { guild, presences, logins, created, roleIds, createClient };
}

test.beforeEach(() => resetPopulationBots());

test('tokens come from a JSON setting; bad or short values are ignored', () => {
  assert.deepEqual(populationBotTokens({ POPULATION_BOT_TOKENS: JSON.stringify({ 'Server 1 Rust': TOKEN, bad: 'short' }) }), { 'Server 1 Rust': TOKEN });
  assert.deepEqual(populationBotTokens({ POPULATION_BOT_TOKENS: 'nope' }), {});
  assert.deepEqual(populationBotTokens({}), {});
});

test('a bot shows 🟢 players/max as custom status and gets the Population role', async () => {
  const w = setup();
  const env = { POPULATION_BOT_TOKENS: JSON.stringify({ 'Server 1 Rust': TOKEN }) };
  const handled = await updatePopulationBots(w.guild, [
    { name: 'Server 1 Rust', online: true, text: '🟢 87/100' },
    { name: 'Server 2 Rust', online: false, text: '🔴 Offline' },
  ], { env, createClient: w.createClient });
  assert.deepEqual([...handled], ['Server 1 Rust']);
  assert.deepEqual(w.logins, [TOKEN]);
  assert.equal(w.presences[0].status, 'online');
  assert.equal(w.presences[0].activities[0].state, '🟢 87/100');
  assert.deepEqual(w.created.map(role => [role.name, role.hoist]), [[POPULATION_ROLE_NAME, true]]);
  assert.ok(w.roleIds.has('role1'));
  // A later update reuses the login and the role.
  await updatePopulationBots(w.guild, [{ name: 'Server 1 Rust', online: false, text: '🔴 Offline' }], { env, createClient: w.createClient });
  assert.equal(w.logins.length, 1);
  assert.equal(w.created.length, 1);
  assert.equal(w.presences[1].status, 'dnd');
});

test('a bot that is not in the server yet is not counted as handled', async () => {
  const w = setup({ inGuild: false });
  const env = { POPULATION_BOT_TOKENS: JSON.stringify({ 'Server 1 Rust': TOKEN }) };
  const handled = await updatePopulationBots(w.guild, [{ name: 'Server 1 Rust', online: true, text: '🟢 1/100' }], { env, createClient: w.createClient });
  assert.equal(handled.size, 0);
});
