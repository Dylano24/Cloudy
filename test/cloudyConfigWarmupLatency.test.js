import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildConfig, warmGuildConfigCache } from '../src/services/config/guildConfig.js';

test('ready warm-up fills normal guild cache before the first interaction', async () => {
  const ids = ['841111111111111111', '842222222222222222', '843333333333333333'];
  const counts = new Map();
  let active = 0;
  let peak = 0;
  const client = {
    guilds: { cache: new Map(ids.map(id => [id, {}])) },
    db: {
      getStatus: () => ({ isDegraded: false }),
      get: async key => {
        active += 1;
        peak = Math.max(peak, active);
        counts.set(key, (counts.get(key) || 0) + 1);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return { prefix: '!', maxTicketsPerUser: 3 };
      },
    },
  };
  const result = await warmGuildConfigCache(client, { concurrency: 2 });
  assert.deepEqual(result, { attempted: 3, warmed: 3 });
  assert.ok(peak <= 2, 'warm-up must never exceed its concurrency limit');
  assert.ok(peak > 1, 'warm-up can use spare capacity without serial reads');

  for (const id of ids) {
    const config = await getGuildConfig(client, id);
    assert.equal(config.maxTicketsPerUser, 3);
  }
  assert.equal([...counts.values()].reduce((sum, value) => sum + value, 0), ids.length,
    'commands should reuse warmed cache rather than querying PostgreSQL again');
});

test('warm-up skips degraded or empty clients without creating writes', async () => {
  assert.deepEqual(await warmGuildConfigCache(null), { attempted: 0, warmed: 0 });
  assert.deepEqual(await warmGuildConfigCache({
    guilds: { cache: new Map([['844444444444444444', {}]]) },
    db: {
      getStatus: () => ({ isDegraded: true }),
      get: () => { throw new Error('degraded reads should not be attempted'); },
    },
  }), { attempted: 0, warmed: 0 });
});
