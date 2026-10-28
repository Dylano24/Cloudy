import test from 'node:test';
import assert from 'node:assert/strict';
import beg from '../src/commands/Economy/beg.js';
import crime from '../src/commands/Economy/crime.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

function fixture(wallet = 500) {
  let account = { ...getInitialEconomyData(), wallet, lastBeg: 0,
    cooldowns: { crime: 0 }, jailedUntil: 0 };
  let queue = Promise.resolve();
  let writes = 0;
  const replies = [];
  const client = { db: {
    getConnectionType: () => 'postgresql',
    async get() { throw new Error('Non-atomic account read'); },
    async set() { throw new Error('Non-atomic account write'); },
    mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
      const operation = queue.then(async () => {
        const next = structuredClone(account);
        const result = await mutate(next);
        account = next;
        writes++;
        return { account: structuredClone(next), result };
      });
      queue = operation.catch(() => {});
      return operation;
    },
  }};
  const interaction = (type = 'pickpocketing') => ({
    id: '1532882647838228726', createdTimestamp: Date.now(),
    user: { id: '1532882647838228724', username: 'player' },
    guildId: '1532882647838228700', options: { getString: () => type },
    deferred: false, replied: false, isChatInputCommand: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
  });
  return { client, interaction, replies, read: () => structuredClone(account), writes: () => writes };
}

test('simultaneous successful /beg attempts cannot grant two rewards', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  const results = await Promise.allSettled([
    beg.execute(f.interaction(), {}, f.client),
    beg.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.writes(), 1);
  assert.ok(f.read().wallet > 500);
  assert.ok(f.read().lastBeg > 0);
  assert.match(JSON.stringify(f.replies[0]), /Begging Successful/);
});

test('failed /beg consumes cooldown but does not subtract or duplicate cash', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture();
  await beg.execute(f.interaction(), {}, f.client);
  assert.equal(f.read().wallet, 500);
  assert.ok(f.read().lastBeg > 0);
  assert.match(JSON.stringify(f.replies[0]), /Insufficient Funds/);
  await assert.rejects(beg.execute(f.interaction(), {}, f.client));
  assert.equal(f.writes(), 1);
});

test('simultaneous successful /crime attempts cannot bypass a cooldown', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture();
  const results = await Promise.allSettled([
    crime.execute(f.interaction(), {}, f.client),
    crime.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.writes(), 1);
  assert.ok(f.read().wallet > 500);
  assert.ok(f.read().cooldowns.crime > 0);
  assert.match(JSON.stringify(f.replies[0]), /Crime Successful/);
});

test('failed /crime commits exactly one fine, jail time and cooldown', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  const results = await Promise.allSettled([
    crime.execute(f.interaction(), {}, f.client),
    crime.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.read().wallet, 440);
  assert.ok(f.read().jailedUntil > Date.now());
  assert.ok(f.read().cooldowns.crime > 0);
  assert.match(JSON.stringify(f.replies[0]), /Crime Failed/);
});
