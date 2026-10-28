import test from 'node:test';
import assert from 'node:assert/strict';
import gamble from '../src/commands/Economy/gamble.js';
import economy from '../src/commands/Economy/economy.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

function fixture(inventory = {}) {
  let account = { ...getInitialEconomyData(), wallet: 500, bank: 40,
    lastGamble: 0, inventory };
  let queue = Promise.resolve();
  let writes = 0;
  const replies = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { throw new Error('Non-atomic account read forbidden'); },
    async set() { throw new Error('Non-atomic account write forbidden'); },
    mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
      const pending = queue.then(async () => {
        const next = structuredClone(account);
        const result = await mutate(next);
        account = next; writes++;
        return { account: structuredClone(next), result };
      });
      queue = pending.catch(() => {});
      return pending;
    },
  }};
  const interaction = (amount, subcommand = null) => ({
    id: '1532882647838228726', createdTimestamp: Date.now(),
    guildId: '1532882647838228700',
    guild: { ownerId: '1532882647838228724' },
    user: { id: '1532882647838228724', username: 'owner' },
    deferred: false, replied: false, isChatInputCommand: () => true,
    options: {
      getInteger: () => amount,
      getSubcommand: () => subcommand,
      getString: () => String(amount),
    },
    async deferReply() { this.deferred = true; },
    async editReply(payload) { this.replied = true; replies.push(payload); },
  });
  return { client, interaction, replies, read: () => structuredClone(account), writes: () => writes };
}

test('two simultaneous /gamble wins grant one reward and consume one clover', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture({ lucky_clover: 1 });
  const results = await Promise.allSettled([
    gamble.execute(f.interaction(100), {}, f.client),
    gamble.execute(f.interaction(100), {}, f.client),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.read().wallet, 600);
  assert.equal(f.read().inventory.lucky_clover, 0);
  assert.ok(f.read().lastGamble > 0);
  assert.equal(f.writes(), 1);
  assert.match(JSON.stringify(f.replies[0]), /You Won/);
  assert.match(JSON.stringify(f.replies[0]), /Lucky Clover/);
});

test('failed /gamble loses only one bet and starts cooldown', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture({ lucky_charm: 2 });
  await gamble.execute(f.interaction(100), {}, f.client);
  assert.equal(f.read().wallet, 400);
  assert.equal(f.read().inventory.lucky_charm, 1);
  assert.equal(f.writes(), 1);
  assert.match(JSON.stringify(f.replies[0]), /You Lost/);
  await assert.rejects(gamble.execute(f.interaction(100), {}, f.client));
  assert.equal(f.read().inventory.lucky_charm, 1);
  assert.equal(f.writes(), 1);
});

test('two simultaneous /economy give operations add cash without lost updates', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    economy.execute(f.interaction(100, 'give'), {}, f.client),
    economy.execute(f.interaction(100, 'give'), {}, f.client),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(f.read().wallet, 700);
  assert.equal(f.read().bank, 40);
  assert.equal(f.writes(), 2);
  assert.equal(f.replies.length, 2);
  assert.match(JSON.stringify(f.replies[1]), /Cash added/);
});
