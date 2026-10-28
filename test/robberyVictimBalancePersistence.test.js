import test from 'node:test';
import assert from 'node:assert/strict';
import rob from '../src/commands/Economy/rob.js';
import { getEconomyKey } from '../src/utils/database/keys.js';

const guildId = '1532882647838228723';
const robberId = '1532882647838228724';
const victimId = '1532882647838228725';

function fixture() {
  const robberKey = getEconomyKey(guildId, robberId);
  const victimKey = getEconomyKey(guildId, victimId);
  const stored = new Map([
    [robberKey, { wallet: 500, bank: 50, lastRob: 0, inventory: {} }],
    [victimKey, { wallet: 2000, bank: 30, lastDaily: 1234, inventory: {} }],
  ]);
  const writes = [];
  const client = {
    db: {
      async get(key) { return structuredClone(stored.get(key)); },
      async set(key, value) {
        writes.push(key);
        // A separate command can update the victim while this robbery is
        // awaiting its own account write. A failed robbery must not erase it.
        if (key === robberKey) {
          const victim = stored.get(victimKey);
          stored.set(victimKey, { ...victim, wallet: 7777 });
        }
        stored.set(key, structuredClone(value));
        return true;
      },
    },
  };
  const payloads = [];
  const interaction = {
    id: '1532882647838228726',
    user: { id: robberId, username: 'robber', tag: 'robber#0001' },
    guildId,
    deferred: false,
    replied: false,
    options: {
      getUser(name) {
        assert.equal(name, 'user');
        return { id: victimId, bot: false, username: 'victim' };
      },
    },
    async deferReply() { this.deferred = true; },
    async editReply(payload) { payloads.push(payload); this.replied = true; },
    isChatInputCommand() { return true; },
  };
  return {
    client, interaction, writes, payloads,
    robberKey, victimKey, read: key => stored.get(key),
  };
}

test('failed robbery never rewrites the victim balance or unrelated data', async t => {
  t.mock.method(Math, 'random', () => 0.99);
  const f = fixture();
  await rob.execute(f.interaction, {}, f.client);
  assert.deepEqual(f.writes, [f.robberKey]);
  assert.equal(f.read(f.victimKey).wallet, 7777);
  assert.equal(f.read(f.victimKey).lastDaily, 1234);
  assert.equal(f.read(f.robberKey).wallet, 450);
  assert.ok(f.read(f.robberKey).lastRob > 0);
  assert.equal(f.payloads.length, 1);
});

test('successful robbery still updates both accounts and retains its existing response', async t => {
  t.mock.method(Math, 'random', () => 0);
  const f = fixture();
  await rob.execute(f.interaction, {}, f.client);
  assert.deepEqual(f.writes, [f.robberKey, f.victimKey]);
  assert.equal(f.read(f.robberKey).wallet, 800);
  assert.equal(f.read(f.victimKey).wallet, 1700);
  assert.equal(f.payloads.length, 1);
});
