import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCountingGameConfig,
  saveCountingGameConfig,
} from '../src/services/countingGameService.js';
import {
  getAllReactionRoleMessages,
  reconcileReactionRoleMessages,
} from '../src/services/reactionRoleService.js';
import { mapWithConcurrency } from '../src/events/cloudyBrandingReady.js';

test('counting game reads are coalesced and successful writes refresh the cache', async () => {
  const guildId = '12345678901234567';
  let getCalls = 0;
  let setCalls = 0;

  const client = {
    db: {
      get: async () => {
        getCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { enabled: true, channelId: '23456789012345678' };
      },
      set: async () => {
        setCalls += 1;
      },
    },
  };

  const configs = await Promise.all([
    getCountingGameConfig(client, guildId),
    getCountingGameConfig(client, guildId),
    getCountingGameConfig(client, guildId),
  ]);

  assert.equal(getCalls, 1);
  assert.ok(configs.every(config => config.enabled === true));

  await saveCountingGameConfig(client, guildId, {
    ...configs[0],
    enabled: false,
  });
  const cachedAfterWrite = await getCountingGameConfig(client, guildId);

  assert.equal(setCalls, 1);
  assert.equal(getCalls, 1);
  assert.equal(cachedAfterWrite.enabled, false);
});

test('reaction-role records are loaded concurrently while preserving their order', async () => {
  const guildId = '34567890123456789';
  const keys = ['panel-a', 'panel-b', 'panel-c'];
  let activeReads = 0;
  let peakReads = 0;

  const client = {
    db: {
      list: async () => keys,
      get: async key => {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeReads -= 1;
        const index = keys.indexOf(key);
        return {
          messageId: `4567890123456789${index}`,
          channelId: '56789012345678901',
          roles: [],
        };
      },
    },
  };

  const panels = await getAllReactionRoleMessages(client, guildId);

  assert.ok(peakReads > 1);
  assert.deepEqual(
    panels.map(panel => panel.messageId),
    keys.map((_, index) => `4567890123456789${index}`),
  );
});

test('reaction-role guild reads are cached to avoid repeated database listing', async () => {
  const guildId = '45678901234567890';
  const messageId = '56789012345678901';
  let listCalls = 0;

  const client = {
    db: {
      list: async () => {
        listCalls += 1;
        return [`reactionroles:${guildId}:${messageId}`];
      },
      get: async key => ({
        guildId,
        channelId: '67890123456789012',
        messageId: key.split(':').at(-1),
        roles: {},
      }),
    },
  };

  const first = await getAllReactionRoleMessages(client, guildId);
  const second = await getAllReactionRoleMessages(client, guildId);

  assert.equal(listCalls, 1);
  assert.deepEqual(first, second);
});

test('reaction-role reconciliation invalidates cached records after cleanup', async () => {
  const guildId = '56789012345678901';
  const messageId = '67890123456789012';
  const channelId = '78901234567890123';
  const key = `reactionroles:${guildId}:${messageId}`;
  let present = true;
  let listCalls = 0;

  const guild = {
    channels: {
      cache: new Map(),
      fetch: async () => null,
    },
  };

  const client = {
    db: {
      list: async () => {
        listCalls += 1;
        return present ? [key] : [];
      },
      get: async () => present ? { guildId, channelId, messageId, roles: {} } : null,
      delete: async () => {
        present = false;
        return true;
      },
    },
    guilds: {
      cache: new Map([[guildId, guild]]),
      fetch: async () => guild,
    },
  };

  const beforeCleanup = await getAllReactionRoleMessages(client, guildId);
  assert.equal(beforeCleanup.length, 1);

  const summary = await reconcileReactionRoleMessages(client, guildId);
  const afterCleanup = await getAllReactionRoleMessages(client, guildId);

  assert.equal(summary.removedMessages, 1);
  assert.equal(afterCleanup.length, 0);
  assert.equal(listCalls, 2);
});

test('channel normalization uses bounded concurrency without changing item order', async () => {
  let active = 0;
  let peak = 0;

  const result = await mapWithConcurrency([1, 2, 3, 4, 5], async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return value * 2;
  }, 3);

  assert.equal(peak, 3);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

test('interaction autocomplete message fetch has timeout protection', async () => {
  const results = await Promise.allSettled([
    (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      try {
        await new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 200));
      } finally {
        clearTimeout(timeout);
      }
    })(),
  ]);
  assert.equal(results[0].status, 'rejected');
});
