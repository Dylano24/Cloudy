import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAdvancedRustLeaderboard, calculateRustPlayerStats, readAdvancedRustLeaderboard,
} from '../src/services/advancedRustLeaderboardService.js';

test('K/D never divides by zero and missing values default to zero', () => {
  assert.deepEqual(calculateRustPlayerStats({ kills: 15, deaths: 0 }), { kills: 15, deaths: 0, kd: 15 });
  assert.deepEqual(calculateRustPlayerStats({ kills: 18, deaths: 6 }), { kills: 18, deaths: 6, kd: 3 });
  assert.deepEqual(calculateRustPlayerStats(null), { kills: 0, deaths: 0, kd: 0 });
});

test('Leaderboard adds K/D without modifying existing board data', () => {
  const state = { leaderboard: { 'Cloudy Rust': {
    since: Date.parse('2026-11-06T19:00:00Z'),
    players: { Agent: { kills: 25, deaths: 5 }, Other: { kills: 8, deaths: 12 } },
  } } };
  const snapshot = JSON.stringify(state);
  const [embed] = buildAdvancedRustLeaderboard(state);
  assert.equal(embed.title, 'Rust leaderboard');
  assert.match(embed.description, /Kills 25 · Deaths 5 · K\/D 5.00/);
  assert.match(embed.footer.text, /Cloudy Inc/);
  assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  assert.equal(JSON.stringify(state), snapshot);
});

test('Leaderboard ignores another Rust server when filtered', () => {
  const state = { leaderboard: {
    'Cloudy Rust': { players: { 'Alpha': { kills: 2, deaths: 1 } } },
    'Cloudy Rust 2': { players: { 'Bravo': { kills: 1, deaths: 3 } } },
  } };
  const embeds = buildAdvancedRustLeaderboard(state, 'Cloudy Rust 2');
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].description, /Bravo/);
  assert.doesNotMatch(embeds[0].description, /Alpha/);
  assert.match(buildAdvancedRustLeaderboard({}, 'Cloudy Rust')[0].description, /No live/);
});

test('Leaderboard reads the existing Cloudy board key', async () => {
  let usedKey = null;
  const client = { db: { get: async key => { usedKey = key; return { leaderboard: {
    'Cloudy Rust': { players: { Alpha: { kills: 5, deaths: 2 } } },
  } }; } } };
  const [embed] = await readAdvancedRustLeaderboard(client, '1532882647838228723');
  assert.equal(usedKey, 'guild:1532882647838228723:gameserver:boards:v1');
  assert.match(embed.description, /K\/D 2.50/);
});
