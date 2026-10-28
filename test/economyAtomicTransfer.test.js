import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import EconomyService from '../src/services/economyService.js';

const guildId = '1532882647838228723';
const senderId = '1532882647838228724';
const recipientId = '1532882647838228725';
const defaults = { wallet: 0, bank: 0, inventory: {}, lastDaily: 0 };

function fixture({ failUpdate = 0, seed = true } = {}) {
  let records = new Map();
  if (seed) {
    records.set(senderId, { wallet: 100, bank: 12, inventory: { key: 2 } });
    records.set(recipientId, { wallet: 20, bank: 34, lastDaily: 1234 });
  }
  let working = null;
  let updateCount = 0;
  let commits = 0;
  let rollbacks = 0;
  let releases = 0;
  const queries = [];
  const query = async (sql, params = []) => {
    queries.push(sql);
    if (sql === 'BEGIN') {
      working = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      records = working;
      working = null;
      commits += 1;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      working = null;
      rollbacks += 1;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO economy')) {
      const [, userId, balance, bank, data] = params;
      if (!working.has(userId)) {
        working.set(userId, { ...structuredClone(data), wallet: balance, bank });
      }
      return { rows: [] };
    }
    if (sql.includes('SELECT user_id, balance, bank, data FROM economy')) {
      return {
        rows: params[1].filter(id => working.has(id)).map(id => {
          const data = structuredClone(working.get(id));
          return { user_id: id, balance: data.wallet, bank: data.bank, data };
        }),
      };
    }
    if (sql.includes('UPDATE economy')) {
      updateCount += 1;
      if (updateCount === failUpdate) throw new Error('database write failed');
      working.set(params[1], structuredClone(params[3]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
  const db = new PostgreSQLDatabase();
  db.isConnected = true;
  db.pool = {
    query,
    async connect() { return { query, release() { releases += 1; } }; },
  };
  return {
    db,
    read: id => structuredClone(records.get(id)),
    snapshot: () => [...records].map(([id, value]) => [id, structuredClone(value)]),
    stats: () => ({ commits, rollbacks, releases, queries }),
  };
}

test('transfer debits and credits together while preserving unrelated fields', async () => {
  const f = fixture();
  const result = await f.db.transferEconomyFunds(guildId, senderId, recipientId, 35, defaults);
  assert.deepEqual(result, { senderNewBalance: 65, receiverNewBalance: 55 });
  assert.deepEqual(f.read(senderId).inventory, { key: 2 });
  assert.equal(f.read(senderId).bank, 12);
  assert.equal(f.read(recipientId).lastDaily, 1234);
  assert.equal(f.read(recipientId).bank, 34);
  assert.equal(f.stats().commits, 1);
  assert.equal(f.stats().rollbacks, 0);
  assert.equal(f.stats().releases, 1);
  assert.equal(f.stats().queries.some(sql => sql.includes('FOR UPDATE')), true);
});

test('failed second account write rolls back the first account write', async () => {
  const f = fixture({ failUpdate: 2 });
  const before = f.snapshot();
  await assert.rejects(
    f.db.transferEconomyFunds(guildId, senderId, recipientId, 35, defaults),
    /database write failed/,
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.stats().commits, 0);
  assert.equal(f.stats().rollbacks, 1);
  assert.equal(f.stats().releases, 1);
});

test('insufficient funds fails without changing either account', async () => {
  const f = fixture();
  const before = f.snapshot();
  await assert.rejects(
    f.db.transferEconomyFunds(guildId, senderId, recipientId, 200, defaults),
    error => error.code === 'ECONOMY_INSUFFICIENT_FUNDS' && error.available === 100,
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.stats().commits, 0);
  assert.equal(f.stats().rollbacks, 1);
});

test('new recipient is created and credited with the configured starting wallet', async () => {
  const f = fixture();
  const newId = '1532882647838228726';
  const result = await f.db.transferEconomyFunds(
    guildId, senderId, newId, 10, { ...defaults, wallet: 5 },
  );
  assert.deepEqual(result, { senderNewBalance: 90, receiverNewBalance: 15 });
  assert.equal(f.read(newId).wallet, 15);
  assert.equal(f.stats().commits, 1);
});

test('production EconomyService chooses atomic storage and keeps payment result', async () => {
  const calls = [];
  const client = {
    db: {
      getConnectionType: () => 'postgresql',
      async transferEconomyFunds(...args) {
        calls.push(args);
        return { senderNewBalance: 85, receiverNewBalance: 35 };
      },
    },
  };
  const result = await EconomyService.transferMoney(client, guildId, senderId, recipientId, 15);
  assert.deepEqual(result, { senderNewBalance: 85, receiverNewBalance: 35 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], guildId);
  assert.equal(calls[0][3], 15);
  assert.equal(typeof calls[0][4].wallet, 'number');
});
