import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import EconomyService from '../src/services/economyService.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

const canRun = process.env.CLOUDY_RUN_ECONOMY_PG_INTEGRATION === 'true'
  && process.env.CI === 'true'
  && Boolean(process.env.POSTGRES_URL);

test('PostgreSQL serializes simultaneous daily claims without awarding twice', {
  skip: !canRun,
}, async () => {
  const stamp = BigInt(Date.now()) * 100000n + BigInt(Math.floor(Math.random() * 100000));
  const guildId = String(stamp);
  const userId = String(stamp + 1n);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, ssl: false, max: 4 });
  const db = new PostgreSQLDatabase();
  db.pool = pool;
  db.isConnected = true;
  const client = { db: {
    getConnectionType: () => 'postgresql',
    mutateEconomyAccount: (...args) => db.mutateEconomyAccount(...args),
  } };
  try {
    const results = await Promise.allSettled([
      EconomyService.claimDaily(client, guildId, userId),
      EconomyService.claimDaily(client, guildId, userId),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    const result = await pool.query(
      'SELECT balance, bank, data FROM economy WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId],
    );
    assert.equal(result.rows.length, 1);
    const saved = result.rows[0];
    assert.equal(Number(saved.balance), getInitialEconomyData().wallet + EconomyService.DAILY_AMOUNT);
    assert.equal(saved.data.wallet, Number(saved.balance));
    assert.ok(saved.data.lastDaily > 0);
  } finally {
    await pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
});
