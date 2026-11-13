import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';
import { isRetiredCommunityCommand, RETIRED_COMMUNITY_COMMAND_NAMES } from '../src/config/retiredCommunityCommands.js';

const RETIRED = ['birthday', 'level', 'leveladd', 'levelremove', 'levelset', 'rank'];

test('only birthday and leveling slash commands are retired', () => {
  assert.deepEqual([...RETIRED_COMMUNITY_COMMAND_NAMES], RETIRED);
  for (const name of RETIRED) assert.equal(isRetiredCommunityCommand(name), true);
  for (const name of ['creator-notify', 'leaderboard', 'vote', 'giveaway', 'ticket', 'auto']) {
    assert.equal(isRetiredCommunityCommand(name), false, name + ' must remain active');
  }
});

test('retired community commands are skipped in runtime and Discord registration', async () => {
  const client = {};
  await loadCommands(client);
  assert.equal(client.commands.size, 98, '96 deployed commands plus /dashboard and /rules');
  for (const name of RETIRED) assert.equal(client.commands.has(name), false, name);
  for (const name of ['creator-notify', 'leaderboard', 'vote', 'giveaway', 'ticket', 'auto']) {
    assert.equal(client.commands.has(name), true, name + ' should remain available');
  }
  const sync = readFileSync('scripts/register-cloudy-guild-commands.js', 'utf8');
  assert.match(sync, /isRetiredCommunityCommand\(payload\?\.name\)/);
});

test('underlying birthday and leveling implementations remain available with their existing data', () => {
  assert.match(readFileSync('src/commands/Birthday/birthday.js', 'utf8'), /setName\('birthday'\)/);
  assert.match(readFileSync('src/commands/Leveling/level.js', 'utf8'), /setName\('level'\)/);
});
