import test from 'node:test';
import assert from 'node:assert/strict';
import fish from '../src/commands/Economy/fish.js';
import mine from '../src/commands/Economy/mine.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

function fixture(inventory = {}) {
  let account = { ...getInitialEconomyData(), wallet: 500, bank: 0,
    lastFish: 0, lastMine: 0, inventory };
  let queue = Promise.resolve();
  let commits = 0;
  const replies = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { throw new Error('Non-atomic account read attempted'); },
    async set() { throw new Error('Non-atomic account write attempted'); },
    mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
      const run = queue.then(async () => {
        const current = structuredClone(account);
        const result = await mutate(current);
        account = current;
        commits++;
        return { account: structuredClone(current), result };
      });
      queue = run.catch(() => {});
      return run;
    },
  }};
  const interaction = () => ({
    id: '1532882647838228726', createdTimestamp: Date.now(),
    user: { id: '1532882647838228724' },
    guildId: '1532882647838228700',
    deferred: false, replied: false, isChatInputCommand: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(p) { this.replied = true; replies.push(p); },
  });
  return { client, interaction, replies, read: () => structuredClone(account), commits: () => commits };
}

test('two simultaneous /fish commands grant only one catch', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  const results = await Promise.allSettled([
    fish.execute(f.interaction(), {}, f.client),
    fish.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.commits(), 1);
  assert.equal(f.read().wallet, 800);
  assert.ok(f.read().lastFish > 0);
  assert.match(JSON.stringify(f.replies[0]), /Fishing Success/);
});

test('fishing rod bonus stays at 50% without consuming the permanent item', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture({ fishing_rod: 1 });
  await fish.execute(f.interaction(), {}, f.client);
  assert.equal(f.read().wallet, 950);
  assert.equal(f.read().inventory.fishing_rod, 1);
  assert.match(JSON.stringify(f.replies[0]), /Fishing Rod Bonus/);
});

test('two simultaneous /mine commands grant only one mining reward', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  const results = await Promise.allSettled([
    mine.execute(f.interaction(), {}, f.client),
    mine.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.commits(), 1);
  assert.equal(f.read().wallet, 900);
  assert.ok(f.read().lastMine > 0);
  assert.match(JSON.stringify(f.replies[0]), /Mining Expedition Successful/);
});

test('diamond pickaxe retains priority over normal pickaxe and adds 100%', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture({ pickaxe: 1, diamond_pickaxe: 1 });
  await mine.execute(f.interaction(), {}, f.client);
  assert.equal(f.read().wallet, 1300);
  assert.equal(f.read().inventory.pickaxe, 1);
  assert.equal(f.read().inventory.diamond_pickaxe, 1);
  assert.match(JSON.stringify(f.replies[0]), /Diamond Pickaxe Bonus/);
});
