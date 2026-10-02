import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustCasinoBalance, settleBet } from '../src/commands/Economy/modules/casinoGameUtils.js';

const guildId = '1532882647838228723';
const userId = '1532882647838228724';
function storage(wallet) {
  let value = { wallet, bank: 45, inventory: { token: 3 } };
  const client = { db: { get: async () => structuredClone(value), set: async (_key, next) => { value = structuredClone(next); } } };
  return { client, read: () => value };
}

test('simultaneous collector payouts preserve current wallet and unrelated economy data', async () => {
  const f = storage(200);
  await Promise.all([
    adjustCasinoBalance(f.client, guildId, userId, 20),
    adjustCasinoBalance(f.client, guildId, userId, 35),
  ]);
  assert.equal(f.read().wallet, 255);
  assert.equal(f.read().bank, 45);
  assert.equal(f.read().inventory.token, 3);
});

test('split or double checks the current balance instead of the starting balance', async () => {
  const f = storage(5);
  await assert.rejects(adjustCasinoBalance(f.client, guildId, userId, -10));
  assert.equal(f.read().wallet, 5);
});

test('failed collector persistence rejects instead of returning an uncommitted balance', async () => {
  const f = storage(100);
  f.client.db.set = async () => { throw new Error('database unavailable'); };
  await assert.rejects(adjustCasinoBalance(f.client, guildId, userId, 20));
  assert.equal(f.read().wallet, 100);
});

test('a failed wallet read cannot reset a player to a default balance', async () => {
  const f = storage(100);
  f.client.db.get = async () => { throw new Error('database unavailable'); };
  await assert.rejects(adjustCasinoBalance(f.client, guildId, userId, 20));
  assert.equal(f.read().wallet, 100);
});

test('instant-game settlement does not acknowledge a failed write', async () => {
  const f = storage(100);
  f.client.db.set = async () => { throw new Error('database unavailable'); };
  await assert.rejects(settleBet({ guildId, user: { id: userId } }, f.client, { wallet: 90 }, 10, 2));
});
