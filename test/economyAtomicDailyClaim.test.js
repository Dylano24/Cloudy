import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import EconomyService from '../src/services/economyService.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

const guildId = '1532882647838228723';
const userId = '1532882647838228724';

function fixture({ failWrite = false } = {}) {
  let saved = { wallet: 55, bank: 5, lastDaily: 0, inventory: { badge: 2 } };
  let transaction = null;
  let committed = 0;
  let rolledBack = 0;
  const query = async (sql, params = []) => {
    if (sql === 'BEGIN') { transaction = structuredClone(saved); return { rows: [] }; }
    if (sql === 'COMMIT') { saved = transaction; transaction = null; committed++; return { rows: [] }; }
    if (sql === 'ROLLBACK') { transaction = null; rolledBack++; return { rows: [] }; }
    if (sql.includes('SELECT balance, bank, data FROM economy')) {
      return { rows: [{ balance: transaction.wallet, bank: transaction.bank, data: structuredClone(transaction) }] };
    }
    if (sql.includes('UPDATE economy')) {
      if (failWrite) throw new Error('write unavailable');
      transaction = structuredClone(params[4]);
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  };
  const db = new PostgreSQLDatabase();
  db.pool = { query, async connect() { return { query, release() {} }; } };
  db.isConnected = true;
  return { db, read: () => structuredClone(saved), stats: () => ({ committed, rolledBack }) };
}

test('atomic daily updates balance, cooldown and unrelated inventory together', async () => {
  const f = fixture();
  const now = Date.now();
  const result = await f.db.mutateEconomyAccount(guildId, userId, getInitialEconomyData(), data => {
    data.wallet += 1000;
    data.lastDaily = now;
  });
  assert.equal(result.account.wallet, 1055);
  assert.equal(f.read().wallet, 1055);
  assert.equal(f.read().lastDaily, now);
  assert.deepEqual(f.read().inventory, { badge: 2 });
  assert.deepEqual(f.stats(), { committed: 1, rolledBack: 0 });
});

test('failed daily account write cannot persist a partial reward', async () => {
  const f = fixture({ failWrite: true });
  await assert.rejects(f.db.mutateEconomyAccount(guildId, userId, getInitialEconomyData(), data => {
    data.wallet += 1000;
    data.lastDaily = Date.now();
  }), /write unavailable/);
  assert.equal(f.read().wallet, 55);
  assert.equal(f.read().lastDaily, 0);
  assert.deepEqual(f.stats(), { committed: 0, rolledBack: 1 });
});

test('daily service dispatches to the atomic account path on PostgreSQL', async () => {
  let calls = 0;
  const now = Date.now();
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async mutateEconomyAccount(_guildId, _userId, initial, mutate) {
      calls++;
      const account = { ...initial, wallet: 30, lastDaily: 0 };
      await mutate(account);
      return { account };
    },
  } };
  const result = await EconomyService.claimDaily(client, guildId, userId);
  assert.equal(calls, 1);
  assert.equal(result.earned, EconomyService.DAILY_AMOUNT);
  assert.equal(result.newWallet, 30 + EconomyService.DAILY_AMOUNT);
  assert.ok(result.nextClaimTime.getTime() >= now + EconomyService.DAILY_COOLDOWN);
});

test('daily service correctly rejects a second claim within cooldown', async () => {
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async mutateEconomyAccount(_guildId, _userId, initial, mutate) {
      const account = { ...initial, wallet: 30, lastDaily: Date.now() };
      return { account, result: await mutate(account) };
    },
  } };
  await assert.rejects(
    EconomyService.claimDaily(client, guildId, userId),
    error => error?.userMessage?.includes('wait before claiming daily'),
  );
});
