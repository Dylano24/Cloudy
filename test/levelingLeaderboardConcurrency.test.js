import test from 'node:test';
import assert from 'node:assert/strict';
import { getLeaderboard } from '../src/services/leveling/leveling.js';

test('leveling leaderboard bounds database fanout and retains tie ordering', async () => {
  const guildId = '1532882647838228723';
  const members = new Map();
  for (let i = 0; i < 38; i++) {
    const id = (1532882647838228800n + BigInt(i)).toString();
    members.set(id, { user: { username: 'player' + i, discriminator: '0', bot: i === 5 } });
  }
  let active = 0;
  let peak = 0;
  let reads = 0;
  const client = {
    guilds: { cache: new Map([[guildId, { members: { async fetch() { return members; } } }]]) },
    db: {
      async get() {
        reads += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        return { xp: 0, level: 1, totalXp: 30 };
      },
    },
  };

  const leaderboard = await getLeaderboard(client, guildId, 100);
  assert.ok(peak > 1, 'database work should retain concurrency');
  assert.ok(peak <= 12, 'database work must stay bounded regardless of guild size');
  assert.equal(reads, 37, 'bots must be omitted without a database read');
  assert.equal(leaderboard.length, 37);
  const expectedOrder = [...members.keys()].filter(id => members.get(id).user.bot === false);
  assert.deepEqual(leaderboard.map(row => row.userId), expectedOrder, 'tied XP uses original member order');
  assert.deepEqual(leaderboard.map(row => row.rank), Array.from({ length: 37 }, (_, i) => i + 1));
});

test('leveling leaderboard retains descending XP ranking with top N limit', async () => {
  const guildId = '1532882647838228723';
  const memberIds = Array.from({ length: 4 }, (_, i) => (1532882647838228800n + BigInt(i)).toString());
  const members = new Map(memberIds.map((id, i) => [id, { user: { username: 'p' + i, bot: false } }]));
  const xpValues = new Map(memberIds.map((id, i) => [id, [2, 20, 10, 20][i]]));
  const client = {
    guilds: { cache: new Map([[guildId, { members: { async fetch() { return members; } } }]]) },
    db: { async get(key) {
      const id = key.split(':').at(-1);
      return { xp: 0, level: 1, totalXp: xpValues.get(id) };
    } },
  };
  const leaderboard = await getLeaderboard(client, guildId, 2);
  assert.deepEqual(leaderboard.map(row => row.userId), [memberIds[1], memberIds[3]]);
  assert.deepEqual(leaderboard.map(row => row.rank), [1, 2]);
});
