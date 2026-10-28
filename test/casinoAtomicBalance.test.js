import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { takeBet, settleBet, adjustCasinoBalance } from '../src/commands/Economy/modules/casinoGameUtils.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

function fixture(wallet = 1000) {
  let account = { ...getInitialEconomyData(), wallet, bank: 45, inventory: { token: 3 } };
  let queue = Promise.resolve();
  let commits = 0;
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { return structuredClone(account); },
    async set() { throw new Error('Non-atomic casino write forbidden'); },
    mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
      const promise = queue.then(async () => {
        const current = structuredClone(account);
        const result = await mutate(current);
        account = current;
        commits++;
        return { account: structuredClone(current), result };
      });
      queue = promise.catch(() => {});
      return promise;
    },
  }};
  const interaction = (amount) => ({
    user: { id: '1532882647838228724' },
    guildId: '1532882647838228723',
    options: { getInteger: () => amount },
  });
  return { client, interaction, read: () => structuredClone(account), commits: () => commits };
}

test('simultaneous Baccarat/Blackjack stake reservations cannot double-spend', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    takeBet(f.interaction(700), f.client),
    takeBet(f.interaction(700), f.client),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(results.find(r => r.status === 'fulfilled').value.alreadyPersisted, true);
  assert.equal(f.read().wallet, 300);
  assert.equal(f.read().bank, 45);
  assert.deepEqual(f.read().inventory, { token: 3 });
  assert.equal(f.commits(), 1);
});

test('Roulette/Slots resolve stake and payout in one transaction', async () => {
  const f = fixture();
  const bet = await takeBet(f.interaction(600), f.client, { settleImmediately: true });
  assert.equal(bet.alreadyPersisted, false);
  assert.equal(f.read().wallet, 1000);
  assert.equal(f.commits(), 0);
  const result = await settleBet(f.interaction(600), f.client, bet.userData, 600, 2);
  assert.deepEqual(result, { payout: 1200, profit: 600, balance: 1600 });
  assert.equal(f.read().wallet, 1600);
  assert.equal(f.commits(), 1);
});

test('concurrent losing instant games cannot withdraw more than wallet', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    settleBet(f.interaction(700), f.client, null, 700, 0),
    settleBet(f.interaction(700), f.client, null, 700, 0),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.read().wallet, 300);
  assert.equal(f.commits(), 1);
});

test('concurrent casino collector wallet deltas serialize across replicas', async () => {
  const f = fixture(100);
  const results = await Promise.allSettled([
    adjustCasinoBalance(f.client, '1532882647838228723', '1532882647838228724', -70),
    adjustCasinoBalance(f.client, '1532882647838228723', '1532882647838228724', -70),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.read().wallet, 30);
  assert.equal(f.commits(), 1);
});

test('casino commands use the reserved-stake contract without duplicate balance saves', () => {
  for (const path of ['baccarat.js', 'blackjack.js']) {
    const source = readFileSync(new URL('../src/commands/Economy/' + path, import.meta.url), 'utf8');
    assert.match(source, /alreadyPersisted/);
    assert.match(source, /!alreadyPersisted && !await setEconomyData/);
  }
  for (const path of ['roulette.js', 'slots.js']) {
    const source = readFileSync(new URL('../src/commands/Economy/' + path, import.meta.url), 'utf8');
    assert.match(source, /settleImmediately: true/);
  }
});
