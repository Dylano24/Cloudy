import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';

const canRun = process.env.CLOUDY_RUN_ECONOMY_PG_INTEGRATION === 'true'
  && process.env.CI === 'true'
  && Boolean(process.env.POSTGRES_URL);

test('real PostgreSQL serializes two-account robbery and rolls back partial errors', {
  skip: !canRun,
}, async () => {
  const base = BigInt(String(Date.now()) + String(Math.floor(Math.random() * 100_000)).padStart(5, '0'));
  const guildId = String(base);
  const robberId = String(base + 1n);
  const victimId = String(base + 2n);
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL, ssl: false, max: 4 });
  const db = new PostgreSQLDatabase();
  db.pool = pool;
  db.isConnected = true;
  const initial = { wallet: 2000, bank: 123, lastRob: 0, inventory: { key: 5 } };
  const users = [robberId, victimId];
  try {
    const attempt = () => db.mutateEconomyAccounts(
      guildId, users, initial, accounts => {
        const robber = accounts.get(robberId);
        const victim = accounts.get(victimId);
        if (robber.lastRob) throw Object.assign(new Error('cooldown'), { code: 'COOLDOWN' });
        robber.wallet += 300;
        victim.wallet -= 300;
        robber.lastRob = Date.now();
        return { robbed: 300 };
      },
    );
    const results = await Promise.allSettled([attempt(), attempt()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'COOLDOWN');
    assert.deepEqual(results.find(r => r.status === 'fulfilled').value.result, { robbed: 300 });

    const query = () => pool.query(
      'SELECT user_id, balance, bank, data FROM economy WHERE guild_id = $1',
      [guildId],
    );
    let rows = (await query()).rows;
    const robber = rows.find(r => r.user_id === robberId);
    const victim = rows.find(r => r.user_id === victimId);
    assert.equal(Number(robber.balance), 2300);
    assert.equal(Number(victim.balance), 1700);
    assert.equal(Number(robber.bank), 123);
    assert.equal(Number(victim.bank), 123);
    assert.equal(robber.data.wallet, 2300);
    assert.equal(victim.data.wallet, 1700);
    assert.deepEqual(robber.data.inventory, { key: 5 });
    assert.ok(robber.data.lastRob > 0);

    await assert.rejects(
      db.mutateEconomyAccounts(guildId, users, initial, accounts => {
        accounts.get(robberId).wallet += 500;
        accounts.get(victimId).wallet -= 500;
        throw new Error('abort transaction');
      }),
      /abort transaction/,
    );
    rows = (await query()).rows;
    assert.equal(Number(rows.find(r => r.user_id === robberId).balance), 2300);
    assert.equal(Number(rows.find(r => r.user_id === victimId).balance), 1700);
  } finally {
    await pool.query('DELETE FROM guilds WHERE id = $1', [guildId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
    await pool.end();
  }
});
