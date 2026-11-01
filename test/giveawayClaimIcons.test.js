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
          assert.match(name, /^cloudy_claim_(gift|info|key|clock|star|check)_white_sm2$/);
          const emoji = { name, id: String(155500000000000000n + BigInt(created.length)) };
          items.set(emoji.id, emoji);
          created.push(emoji);
          return emoji;
        },
      },
    },
  };
  const icons = await getGiveawayClaimIcons(client);
  assert.equal(created.length, 6);
  assert.equal(fetches, 1);
  assert.deepEqual(Object.keys(icons), ['gift', 'info', 'key', 'clock', 'star', 'check']);
  for (const icon of Object.values(icons)) {
    assert.match(icon, /^<:cloudy_claim_(?:gift|info|key|clock|star|check)_white_sm2:\d+>$/);
  }
  assert.deepEqual(await getGiveawayClaimIcons(client), icons);
  assert.equal(fetches, 1);

  const panel = claimPanel({ messageId: '123', prize: 'PlayStation Store gift card' }, '456', icons);
  const embed = panel.embeds[0];
  assert.equal(embed.title, undefined);
  assert.equal(embed.color, 0xFFFFFF);
  assert.equal(embed.thumbnail.url.includes('cloudy-c-logo'), true);
  assert.match(embed.description, /Congratulations on winning!/);
  assert.match(embed.description, /Claim your code here/);
  assert.match(embed.description, /DEMO-/);
  assert.match(embed.description, /Important/);
  assert.match(embed.description, /Prize details/);
  assert.match(embed.description, /Your review/);
  assert.ok(embed.description.includes(icons.star + ' **Your review**'));
  assert.match(embed.description, /PlayStation Store gift card/);
  assert.doesNotMatch(embed.description, /How to claim|Your prize/);
  assert.match(embed.description, /24 hours/);
  assert.match(embed.description, new RegExp(icons.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(embed.description, new RegExp(icons.clock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const controls = panel.components[0].toJSON().components;
  assert.deepEqual(controls.map(item => item.label), ['Prize taken', 'Rate us']);
  assert.equal(controls[0].style, 2);
  assert.equal(controls[1].style, 5);
  assert.equal(controls[0].emoji.id, icons.check.split(':')[2].slice(0, -1));
  assert.equal(controls[1].emoji.id, icons.star.split(':')[2].slice(0, -1));
  assert.match(controls[1].url, /1554538609330225225/);
});
