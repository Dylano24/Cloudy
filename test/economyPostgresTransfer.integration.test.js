import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';

// Only the isolated GitHub migration-check job supplies an ephemeral database.
// Running ordinary local tests never mutates a developer or production database.
const canRun = process.env.CLOUDY_RUN_ECONOMY_PG_INTEGRATION === 'true'
  && process.env.CI === 'true'
  && Boolean(process.env.POSTGRES_URL);

test('real PostgreSQL commits both balances, preserves data and serializes concurrent transfers', {
  skip: !canRun,
}, async () => {
  const base = BigInt(String(Date.now()) + String(Math.floor(Math.random() * 100_000)).padStart(5, '0'));
  const guildId = String(base);
  const senderId = String(base + 1n);
  const firstId = String(base + 2n);
  const secondId = String(base + 3n);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, ssl: false, max: 4 });
  const db = new PostgreSQLDatabase();
  db.pool = pool;
  db.isConnected = true;
  const initial = { wallet: 100, bank: 23, inventory: { key: 5 }, lastDaily: 123 };

  try {
    const first = await db.transferEconomyFunds(guildId, senderId, firstId, 25, initial);
    assert.deepEqual(first, { senderNewBalance: 75, receiverNewBalance: 125 });

    await Promise.all([
      db.transferEconomyFunds(guildId, senderId, firstId, 6, initial),
      db.transferEconomyFunds(guildId, senderId, secondId, 7, initial),
    ]);

    const result = await pool.query(
      'SELECT user_id, balance, bank, data FROM economy WHERE guild_id = $1',
      [guildId],
    );
    const accounts = new Map(result.rows.map(row => [row.user_id, row]));
    assert.equal(Number(accounts.get(senderId).balance), 62);
    assert.equal(Number(accounts.get(firstId).balance), 131);
    assert.equal(Number(accounts.get(secondId).balance), 107);
    for (const id of [senderId, firstId, secondId]) {
      const row = accounts.get(id);
      assert.equal(Number(row.bank), 23);
      assert.deepEqual(row.data.inventory, { key: 5 });
      assert.equal(row.data.lastDaily, 123);
      assert.equal(Number(row.balance), row.data.wallet);
    }

    await assert.rejects(
      db.transferEconomyFunds(guildId, senderId, firstId, 999, initial),
      error => error.code === 'ECONOMY_INSUFFICIENT_FUNDS',
    );
    const after = await pool.query(
      'SELECT user_id, balance FROM economy WHERE guild_id = $1',
      [guildId],
    );
    assert.equal(Number(after.rows.find(row => row.user_id === senderId).balance), 62);
  } finally {
    await pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[senderId, firstId, secondId]]);
    await pool.end();
  }
});
