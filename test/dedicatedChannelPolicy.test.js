import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { findDedicatedChannelBySlug } from '../src/services/dedicatedChannelPolicy.js';

function channel(id, name) {
  return {
    id,
    name,
    isTextBased: () => true,
    isSendable: () => true,
  };
}

test('exact dedicated shop channel wins over similarly named channels', () => {
  const shopLogs = channel('1', 'shop-logs');
  const oldShop = channel('2', 'old-shop');
  const shop = channel('3', 'shop');
  const guild = {
    channels: {
      cache: new Collection([
        [shopLogs.id, shopLogs],
        [oldShop.id, oldShop],
        [shop.id, shop],
      ]),
    },
  };

  assert.equal(findDedicatedChannelBySlug(guild, 'shop')?.id, shop.id);
});

test('decorated channel names remain a fallback when no exact channel exists', () => {
  const decorated = channel('4', '🛒｜shop');
  const guild = {
    channels: {
      cache: new Collection([[decorated.id, decorated]]),
    },
  };

  assert.equal(findDedicatedChannelBySlug(guild, 'shop')?.id, decorated.id);
});