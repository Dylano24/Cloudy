import test from 'node:test';
import assert from 'node:assert/strict';
import deposit from '../src/commands/Economy/deposit.js';
import withdraw from '../src/commands/Economy/withdraw.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

function fixture({ wallet = 900, bank = 100 } = {}) {
  let account = { ...getInitialEconomyData(), wallet, bank };
  let queue = Promise.resolve();
  let writes = 0;
  let staleWrites = 0;
  const replies = [];
  const warnings = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { throw new Error('Stale account read is forbidden'); },
    async set() { staleWrites++; throw new Error('Stale account save is forbidden'); },
    mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
      const pending = queue.then(async () => {
        const current = structuredClone(account);
        const result = await mutate(current);
        account = current; writes++;
        return { account: structuredClone(current), result };
      });
      queue = pending.catch(() => {});
      return pending;
    },
  }};
  const interaction = (input) => ({
    id: '1532882647838228726', createdTimestamp: Date.now(),
    guildId: '1532882647838228700',
    user: { id: '1532882647838228724', tag: 'banker#0001' },
    deferred: false, replied: false, isChatInputCommand: () => true,
    options: { getString: () => String(input), getInteger: () => input },
    async deferReply() { this.deferred = true; },
    async editReply(value) { replies.push(value); this.replied = true; },
    async followUp(value) { warnings.push(value); return value; },
  });
  return { client, interaction, replies, warnings,
    read: () => structuredClone(account),
    stats: () => ({ writes, staleWrites }),
  };
}

test('concurrent /deposit amounts transfer only available wallet and conserve money', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([
    deposit.execute(f.interaction('600'), {}, f.client),
    deposit.execute(f.interaction('600'), {}, f.client),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 2);
  assert.deepEqual({ wallet: f.read().wallet, bank: f.read().bank }, { wallet: 0, bank: 1000 });
  assert.equal(f.stats().writes, 2);
  assert.equal(f.stats().staleWrites, 0);
  assert.equal(f.warnings.length, 1);
  assert.match(JSON.stringify(f.warnings[0]), /remaining cash/);
  assert.equal(f.replies.length, 2);
});

test('simultaneous /withdraw commands cannot spend an empty bank twice', async () => {
  const f = fixture({ wallet: 100, bank: 700 });
  const outcomes = await Promise.allSettled([
    withdraw.execute(f.interaction(1000), {}, f.client),
    withdraw.execute(f.interaction(1000), {}, f.client),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.read().wallet, 800);
  assert.equal(f.read().bank, 0);
  assert.deepEqual(f.stats(), { writes: 1, staleWrites: 0 });
  assert.equal(f.replies.length, 1);
});

test('a deposit respects max bank capacity while preserving user warning text', async () => {
  const f = fixture({ wallet: 500, bank: 9990 });
  await deposit.execute(f.interaction('50'), {}, f.client);
  assert.equal(f.read().bank, 10000);
  assert.equal(f.read().wallet, 490);
  assert.equal(f.warnings.length, 1);
  assert.match(JSON.stringify(f.warnings[0]), /only had space/);
  assert.match(JSON.stringify(f.replies[0]), /Deposit Successful/);
});

test('concurrent deposit and withdraw conserve total account funds', async () => {
  const f = fixture({ wallet: 500, bank: 500 });
  const outcomes = await Promise.allSettled([
    deposit.execute(f.interaction('all'), {}, f.client),
    withdraw.execute(f.interaction(500), {}, f.client),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 2);
  assert.equal(f.read().wallet + f.read().bank, 1000);
  assert.deepEqual(f.stats(), { writes: 2, staleWrites: 0 });
});
