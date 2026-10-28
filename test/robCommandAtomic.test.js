import test from 'node:test';
import assert from 'node:assert/strict';
import rob from '../src/commands/Economy/rob.js';

const guildId = '1532882647838228723';
const robberId = '1532882647838228724';
const victimId = '1532882647838228725';

function fixture({ safe = false } = {}) {
  const accounts = new Map([
    [robberId, { wallet: 500, bank: 50, lastRob: 0, inventory: {} }],
    [victimId, { wallet: 2000, bank: 30, lastDaily: 1234,
      inventory: safe ? { personal_safe: 1 } : {} }],
  ]);
  let queue = Promise.resolve();
  let atomicCommits = 0;
  let staleWrites = 0;
  const payloads = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { throw new Error('Non-atomic read forbidden'); },
    async set() { staleWrites++; throw new Error('Non-atomic write forbidden'); },
    mutateEconomyAccounts(_guildId, ids, _initial, mutate) {
      assert.deepEqual(new Set(ids), new Set([robberId, victimId]));
      const pending = queue.then(async () => {
        const current = new Map([...accounts].map(([k, v]) => [k, structuredClone(v)]));
        const result = await mutate(current);
        for (const [k, v] of current) accounts.set(k, v);
        atomicCommits++;
        return { accounts: current, result };
      });
      queue = pending.catch(() => {});
      return pending;
    },
  }};
  const interaction = () => ({
    id: '1532882647838228726', guildId, createdTimestamp: Date.now(),
    user: { id: robberId, username: 'robber', tag: 'robber#0001' },
    options: { getUser: () => ({ id: victimId, username: 'victim', bot: false }) },
    deferred: false, replied: false, isChatInputCommand: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { this.replied = true; payloads.push(payload); },
  });
  return {
    client, interaction, payloads,
    read: id => structuredClone(accounts.get(id)),
    commits: () => atomicCommits,
    staleWrites: () => staleWrites,
  };
}

test('concurrent successful /rob cannot double-spend the victim or bypass cooldown', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  const outcomes = await Promise.allSettled([
    rob.execute(f.interaction(), {}, f.client),
    rob.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
  assert.equal(f.commits(), 1);
  assert.equal(f.staleWrites(), 0);
  assert.equal(f.read(robberId).wallet, 800);
  assert.equal(f.read(victimId).wallet, 1700);
  assert.equal(f.read(victimId).lastDaily, 1234);
  assert.equal(f.payloads.length, 1);
  assert.match(JSON.stringify(f.payloads[0]), /Robbery successful/);
});

test('protected victim blocks robbery and charges only the robber cooldown', async () => {
  const f = fixture({ safe: true });
  await rob.execute(f.interaction(), {}, f.client);
  assert.equal(f.read(robberId).wallet, 500);
  assert.equal(f.read(victimId).wallet, 2000);
  assert.equal(f.read(victimId).inventory.personal_safe, 1);
  assert.ok(f.read(robberId).lastRob > 0);
  assert.equal(f.commits(), 1);
  assert.match(JSON.stringify(f.payloads[0]), /Robbery blocked/);
});

test('failed robbery fines robber but does not spend victim wallet', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture();
  await rob.execute(f.interaction(), {}, f.client);
  assert.equal(f.read(robberId).wallet, 450);
  assert.equal(f.read(victimId).wallet, 2000);
  assert.equal(f.commits(), 1);
  assert.equal(f.staleWrites(), 0);
  assert.match(JSON.stringify(f.payloads[0]), /Robbery failed/);
});
