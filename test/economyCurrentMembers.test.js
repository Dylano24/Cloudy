import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { buildEconomyLeaderboardEmbed } from '../src/commands/Economy/eleaderboard.js';

const guildId = '1532882647838228723';

function fixture() {
  const accounts = new Map(Array.from({ length: 14 }, (_, i) => [
    String(1532882647838228800n + BigInt(i)), { wallet: 100 - i, bank: 0 },
  ]));
  const current = new Collection([...accounts.keys()].slice(3).map(id => [id, { id }]));
  let fetches = 0;
  const guild = { members: {
    cache: new Collection([...accounts.keys()].map(id => [id, { id }])),
    fetch: async () => { fetches++; return current; },
  } };
  const client = {
    guilds: { cache: new Collection([[guildId, guild]]) },
    db: {
      list: async () => [...accounts.keys()].map(id => `guild:${guildId}:economy:${id}`),
      getGuildEconomyAccounts: async () => accounts,
    },
  };
  return { client, guild, fetches: () => fetches };
}

test('leaderboard excludes departed members before taking ten places and numbers every rank', async () => {
  const f = fixture();
  const data = (await buildEconomyLeaderboardEmbed(f.client, guildId, '1532882647838228803')).toJSON();
  const lines = data.description.split('\n');
  assert.equal(lines.length, 10);
  assert.match(lines[0], /^\*\*#1\*\* <@1532882647838228803> - 97$/);
  assert.match(lines[1], /^\*\*#2\*\* <@1532882647838228804> - 96$/);
  assert.match(lines[2], /^\*\*#3\*\* <@1532882647838228805> - 95$/);
  assert.match(lines[9], /^\*\*#10\*\* <@1532882647838228812> - 88$/);
  assert.doesNotMatch(data.description, /153288264783822880[012]>/);
  assert.equal(f.fetches(), 1);
});

test('leaderboard never substitutes a stale member cache when membership verification fails', async () => {
  const f = fixture();
  f.guild.members.fetch = async () => { throw new Error('Discord member lookup unavailable'); };
  await assert.rejects(buildEconomyLeaderboardEmbed(f.client, guildId, '1532882647838228803'),
    /Discord member lookup unavailable/);
});
