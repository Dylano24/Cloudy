import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCountingGameConfig,
  saveCountingGameConfig,
} from '../src/services/countingGameService.js';
import { getAllReactionRoleMessages } from '../src/services/reactionRoleService.js';

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
