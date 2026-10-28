import test from 'node:test';
import assert from 'node:assert/strict';
import work from '../src/commands/Economy/work.js';
import { botConfig } from '../src/config/bot.js';
import { getInitialEconomyData } from '../src/utils/economy.js';

const guildId = '1532882647838228700';
const userId = '1532882647838228724';

function fixture({ extraShifts = 0, laptop = false } = {}) {
  let account = {
    ...getInitialEconomyData(),
    wallet: 400,
    lastWork: 0,
    inventory: { extra_work: extraShifts, laptop: laptop ? 1 : 0 },
  };
  let queue = Promise.resolve();
  let atomicWrites = 0;
  let staleWrites = 0;
  const replies = [];
  const client = {
    db: {
      getConnectionType: () => 'postgresql',
      async get() {
        // A stale non-locking snapshot must not be used by production /work.
        throw new Error('Non-atomic economy read attempted');
      },
      async set() { staleWrites++; throw new Error('Non-atomic economy write attempted'); },
      mutateEconomyAccount(_guildId, _userId, _initial, mutate) {
        const next = queue.then(async () => {
          const current = structuredClone(account);
          const result = await mutate(current);
          account = current;
          atomicWrites += 1;
          return { account: structuredClone(current), result };
        });
        queue = next.catch(() => {});
        return next;
      },
    },
  };
  function interaction() {
    return {
      id: '1532882647838228726', createdTimestamp: Date.now(),
      guildId, user: {
        id: userId, tag: 'worker#0001',
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
      deferred: false, replied: false, isChatInputCommand: () => true,
      async deferReply() { this.deferred = true; },
      async editReply(payload) { replies.push(payload); this.replied = true; },
    };
  }
  return {
    client, interaction, replies,
    read: () => structuredClone(account),
    stats: () => ({ atomicWrites, staleWrites }),
  };
}

test('two simultaneous /work commands cannot claim the same cooldown', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    work.execute(f.interaction(), {}, f.client),
    work.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal(f.stats().atomicWrites, 1);
  assert.equal(f.stats().staleWrites, 0);
  assert.ok(f.read().lastWork > 0);
  assert.equal(f.replies.length, 1);
  const earned = f.read().wallet - 400;
  assert.ok(earned >= (botConfig.economy?.workMin ?? 10));
  assert.ok(earned <= (botConfig.economy?.workMax ?? 100));
});

test('two extra work consumables permit two claims, with each item spent once', async () => {
  const f = fixture({ extraShifts: 2 });
  const results = await Promise.allSettled([
    work.execute(f.interaction(), {}, f.client),
    work.execute(f.interaction(), {}, f.client),
    work.execute(f.interaction(), {}, f.client),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 3);
  assert.equal(f.read().inventory.extra_work, 0);
  assert.equal(f.stats().atomicWrites, 3);
  assert.equal(f.stats().staleWrites, 0);
  assert.equal(f.replies.length, 3);
  const fourth = await Promise.allSettled([work.execute(f.interaction(), {}, f.client)]);
  assert.equal(fourth[0].status, 'rejected');
  assert.equal(f.read().inventory.extra_work, 0);
  assert.equal(f.stats().atomicWrites, 3);
});

test('existing laptop bonus and public success embed remain unchanged', async () => {
  const f = fixture({ laptop: true });
  await work.execute(f.interaction(), {}, f.client);
  assert.equal(f.replies.length, 1);
  const embed = f.replies[0].embeds[0];
  const data = embed.toJSON?.() || embed;
  assert.match(data.description, /Laptop Bonus:.*50%/);
  assert.match(data.description, /worked as a/);
  assert.equal(data.fields[0].name, 'New Balance');
  assert.equal(data.fields[1].name, 'Next Work');
  assert.match(data.fields[1].value, /^<t:\d+:R>$/);
  assert.equal(f.read().inventory.laptop, 1);
  assert.equal(f.stats().staleWrites, 0);
});
