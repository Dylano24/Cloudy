import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { DatabaseWrapper } from '../src/utils/database/wrapper.js';
import { buildEconomyLeaderboardEmbed } from '../src/commands/Economy/eleaderboard.js';
import { buildDashboardEmbed } from '../src/commands/Economy/modules/economy_dashboard.js';
import { readGuildEconomyValues } from '../src/utils/economy.js';

const GUILD = '1300000000000000001';
const users = {
  '1300000000000000011': { balance: 50, bank: 50, data: { wallet: 900, bank: 100, inventory: { gem: 1 } } },
  '1300000000000000012': { balance: 300, bank: 700, data: {} },
  '1300000000000000013': { balance: 1000, bank: 0, data: null },
  '1300000000000000014': { balance: 0, bank: 0, data: { wallet: 0, bank: 0 } },
  '1300000000000000015': { balance: 5, bank: 1, data: { wallet: 500, bank: 500 } },
};

// A pool double that answers the exact economy queries PostgreSQLDatabase issues.
function postgres() {
  const queries = [];
  const database = new PostgreSQLDatabase();
  database.isConnected = true;
  database.pool = {
    query: async (sql, params) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      const rows = Object.entries(users).map(([user_id, row]) => ({ user_id, ...structuredClone(row) }));
      if (/WHERE guild_id = \$1 AND user_id = \$2/.test(sql)) {
        return { rows: params[0] === GUILD ? rows.filter(row => row.user_id === params[1]) : [] };
      }
      if (/SELECT user_id, balance, bank, data FROM economy WHERE guild_id = \$1$/.test(sql.trim())) {
        return { rows: params[0] === GUILD ? rows : [] };
      }
      if (/SELECT user_id FROM economy WHERE guild_id = \$1/.test(sql)) {
        return { rows: params[0] === GUILD ? rows.map(({ user_id }) => ({ user_id })) : [] };
      }
      return { rows: [] };
    },
  };
  return { database, queries };
}

function clientFor({ bulk }) {
  const { database, queries } = postgres();
  const wrapper = new DatabaseWrapper();
  wrapper.db = bulk ? database : {
    get: database.get.bind(database),
    list: database.list.bind(database),
  };
  wrapper.initialized = true;
  return { client: { db: wrapper }, queries };
}

test('whole-guild economy read returns exactly what each per-account read returns', async () => {
  const { database } = postgres();
  const bulk = await database.getGuildEconomyAccounts(GUILD);
  for (const userId of Object.keys(users)) {
    assert.deepEqual(bulk.get(userId), await database.get(`guild:${GUILD}:economy:${userId}`), userId);
  }
  assert.equal(bulk.size, Object.keys(users).length);
});

test('leaderboard is identical, ties keep their order, and one query replaces one per account', async () => {
  const legacy = clientFor({ bulk: false });
  const fast = clientFor({ bulk: true });
  const before = await buildEconomyLeaderboardEmbed(legacy.client, GUILD, '1300000000000000013');
  const after = await buildEconomyLeaderboardEmbed(fast.client, GUILD, '1300000000000000013');
  assert.deepEqual(after.toJSON(), before.toJSON());
  assert.match(after.toJSON().description, /0000011> - 1,000\n.*0000012> - 1,000\n.*0000013> - 1,000\n.*0000015> - 1,000/);
  const perAccount = queries => queries.filter(sql => sql.includes('AND user_id = $2')).length;
  assert.equal(perAccount(legacy.queries), Object.keys(users).length);
  assert.equal(perAccount(fast.queries), 0);
});

test('economy dashboard totals are identical and bots are still skipped', async () => {
  const guild = {
    id: GUILD, name: 'Cloudy',
    members: { cache: new Collection([['1300000000000000015', { user: { bot: true } }]]) },
  };
  const before = (await buildDashboardEmbed(guild, clientFor({ bulk: false }).client)).toJSON();
  const after = (await buildDashboardEmbed(guild, clientFor({ bulk: true }).client)).toJSON();
  delete before.timestamp; delete after.timestamp;
  assert.deepEqual(after, before);
  assert.equal(after.fields.find(field => field.name.includes('Active Users')).value, '`4`');
});

test('keys outside the bulk result keep the original per-key read and default', async () => {
  const reads = [];
  const client = { db: {
    getGuildEconomyAccounts: async () => new Map([['1', { wallet: 1, bank: 2 }]]),
    get: async (key, fallback) => { reads.push(key); return fallback; },
  } };
  const keys = [`guild:${GUILD}:economy:1`, `guild:${GUILD}:economy:2`, `guild:${GUILD}:economy:3:extra`];
  assert.deepEqual(await readGuildEconomyValues(client, GUILD, keys, {}), [{ wallet: 1, bank: 2 }, {}, {}]);
  assert.deepEqual(reads, keys.slice(1));
  const failing = { db: { getGuildEconomyAccounts: async () => { throw new Error('PostgreSQL down'); } } };
  await assert.rejects(readGuildEconomyValues(failing, GUILD, keys), /PostgreSQL down/);
});
