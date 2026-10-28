import test from 'node:test';
import assert from 'node:assert/strict';
import daily from '../src/commands/Economy/daily.js';
import { botConfig } from '../src/config/bot.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

const userId = '1532882647838228724';

function fixture(guildId, premium = false) {
  let account = { ...getInitialEconomyData(), wallet: 400, lastDaily: 0 };
  let queue = Promise.resolve();
  let atomicWrites = 0;
  let staleWrites = 0;
  const replies = [];
  const client = {
    db: {
      getConnectionType: () => 'postgresql',
      async get(key) {
        if (key.endsWith(':config')) {
          return { premiumRoleId: premium ? '1532882647838228888' : null };
        }
        return structuredClone(account);
      },
      async set() { staleWrites++; throw new Error('Old non-atomic save must not run'); },
      mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
        const pending = queue.then(async () => {
          const next = structuredClone(account);
          await mutate(next);
          account = next;
          atomicWrites++;
          return { account: structuredClone(next) };
        });
        queue = pending.catch(() => {});
        return pending;
      },
    },
  };
  const interaction = () => ({
    id: '1532882647838228726',
    createdTimestamp: Date.now(),
    user: { id: userId, username: 'player' },
    guildId,
    member: { roles: { cache: { has: roleId => premium && roleId === '1532882647838228888' } } },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
  });
  return { client, interaction, read: () => account, stats: () => ({ atomicWrites, staleWrites }), replies };
}

test('actual /daily command grants only one reward during simultaneous claims', async () => {
  const f = fixture('1532882647838228700');
  const outcomes = await Promise.allSettled([
    daily.execute(f.interaction(), {}, f.client),
    daily.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.read().wallet, 400 + (botConfig.economy?.dailyAmount ?? 100));
  assert.ok(f.read().lastDaily > 0);
  assert.deepEqual(f.stats(), { atomicWrites: 1, staleWrites: 0 });
  assert.equal(f.replies.length, 1);
});

test('actual /daily preserves premium reward and existing embed presentation', async () => {
  const f = fixture('1532882647838228701', true);
  await daily.execute(f.interaction(), {}, f.client);
  const base = botConfig.economy?.dailyAmount ?? 100;
  const bonus = Math.floor(base * 0.1);
  assert.equal(f.read().wallet, 400 + base + bonus);
  assert.equal(f.replies.length, 1);
  const embed = f.replies[0].embeds[0];
  const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  assert.match(data.description, /Premium Bonus/);
  assert.match(data.description, /daily/i);
  assert.deepEqual(f.stats(), { atomicWrites: 1, staleWrites: 0 });
});
