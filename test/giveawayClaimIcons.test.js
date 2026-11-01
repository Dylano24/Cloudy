import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { getGiveawayClaimIcons } from '../src/services/giveawayClaimIcons.js';
import { claimPanel } from '../src/services/giveawayClaimService.js';

test('white Cloudy claim icons are PNG application emojis and render in the claim panel', async () => {
  const items = new Collection();
  const created = [];
  let fetches = 0;
  const client = {
    application: {
      emojis: {
        fetch: async () => { fetches++; return items; },
        create: async ({ name, attachment }) => {
          assert.equal(Buffer.isBuffer(attachment), true);
          assert.deepEqual([...attachment.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
          assert.match(name, /^cloudy_claim_(gift|info|key|clock)_white$/);
          const emoji = { name, id: String(155500000000000000n + BigInt(created.length)) };
          items.set(emoji.id, emoji);
          created.push(emoji);
          return emoji;
        },
      },
    },
  };
  const icons = await getGiveawayClaimIcons(client);
  assert.equal(created.length, 4);
  assert.equal(fetches, 1);
  assert.deepEqual(Object.keys(icons), ['gift', 'info', 'key', 'clock']);
  for (const icon of Object.values(icons)) {
    assert.match(icon, /^<:cloudy_claim_(?:gift|info|key|clock)_white:\d+>$/);
  }
  assert.deepEqual(await getGiveawayClaimIcons(client), icons);
  assert.equal(fetches, 1);

  const panel = claimPanel({ messageId: '123', prize: '6 months VIP' }, '456', icons);
  const embed = panel.embeds[0];
  assert.equal(embed.title, undefined);
  assert.equal(embed.color, 0xFFFFFF);
  assert.equal(embed.thumbnail.url.includes('cloudy-c-logo'), true);
  assert.match(embed.description, /This prize is valid for 6 months after activation/);
  assert.match(embed.description, /Your prize is ready to be claimed/);
  assert.match(embed.description, /Once your code is available, click \*\*Take code\*\*/);
  const positions = [
    icons.gift + ' **Your prize**',
    icons.info + ' **Prize details**',
    icons.key + ' **How to claim**',
    icons.clock + ' **Important**',
  ].map(label => embed.description.indexOf(label));
  assert.ok(positions.every((pos, i) => pos >= 0 && (!i || pos > positions[i - 1])));
  assert.doesNotMatch(embed.description, /🎁|🔑|⏱️/);
  assert.deepEqual(panel.components[0].toJSON().components.map(button => button.label), ['Take code']);
});
