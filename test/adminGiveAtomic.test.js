import test from 'node:test';
import assert from 'node:assert/strict';
import giveMoney from '../src/commands/Economy/currency.js';
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

test('two simultaneous /give money me operations add cash without lost updates', async () => {
  const f = fixture();
  const ownerInteraction = () => Object.assign(f.interaction(100, 'me'), {
    channelId: '1533188412507558130',
    guild: { ownerId: '1532882647838228724', channels: { cache: { find: fn => {
      const channel = { id: '1533188412507558130', name: 'gambling', isTextBased: () => true, isSendable: () => true };
      return fn(channel) ? channel : undefined;
    } } } },
  });
  const results = await Promise.allSettled([
    giveMoney.execute(ownerInteraction(), {}, f.client),
    giveMoney.execute(ownerInteraction(), {}, f.client),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(f.read().wallet, 700);
  assert.equal(f.read().bank, 40);
  assert.equal(f.writes(), 2);
  assert.equal(f.replies.length, 2);
  assert.match(JSON.stringify(f.replies[1]), /Money added/);
});
