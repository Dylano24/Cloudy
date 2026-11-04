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
          if (name === 'cloudy_claim_gift_white_sm5') {
            assert.equal(attachment.readUInt32BE(16), 40);
            assert.equal(attachment.readUInt32BE(20), 40);
            assert.ok(attachment.length < 10_000);
            assert.ok(attachment.length < 2_000, 'resized inline gift should remain a compact transparent PNG');
          }
          assert.match(name, /^cloudy_claim_(info|key|clock|check)_white_sm2$|^cloudy_claim_gift_white_sm5$|^cloudy_claim_star_white_sm3$|^cloudy_claim_warning_white_sm1$/);
          const emoji = { name, id: String(155500000000000000n + BigInt(created.length)) };
          items.set(emoji.id, emoji);
          created.push(emoji);
          return emoji;
        },
      },
    },
  };
  const icons = await getGiveawayClaimIcons(client);
  assert.equal(created.length, 7);
  assert.equal(fetches, 1);
  assert.deepEqual(Object.keys(icons), ['gift', 'info', 'key', 'clock', 'star', 'check', 'warning']);
  for (const icon of Object.values(icons)) {
    assert.match(icon, /^<:cloudy_claim_(?:info|key|clock|check)_white_sm2:\d+>$|^<:cloudy_claim_gift_white_sm5:\d+>$|^<:cloudy_claim_star_white_sm3:\d+>$|^<:cloudy_claim_warning_white_sm1:\d+>$/);
  }
  assert.deepEqual(await getGiveawayClaimIcons(client), icons);
  assert.equal(fetches, 1);
  assert.match(icons.star, /cloudy_claim_star_white_sm3/);
  assert.match(icons.clock, /cloudy_claim_clock_white_sm2/);
  assert.match(icons.warning, /cloudy_claim_warning_white_sm1/);
  assert.match(icons.gift, /cloudy_claim_gift_white_sm5/);

  const panel = claimPanel({ messageId: '123', guildId: 'test-guild', prize: 'PlayStation Store gift card' }, '456', icons);
  const embed = panel.embeds[0];
  assert.equal(embed.title, undefined);
  assert.equal(embed.color, 0xFFFFFF);
  assert.equal(embed.thumbnail, undefined);
  assert.match(embed.description, /Cloudy Inc.*congratulates you on winning this prize/);
  assert.match(embed.description, /Prize conditions/);
  assert.match(embed.description, /How to get your prize/);
  assert.match(embed.description, /Reveal my code/);
  assert.match(embed.description, /Share your feedback/);
  assert.match(embed.description, /Please note/);
  assert.match(embed.description, /You can also close this channel yourself using the \*\*Close\*\* button below\./);
  assert.match(embed.description, /24 hours/);
  assert.ok(embed.description.includes(icons.gift + ' **PlayStation Store gift card**'));
  assert.match(embed.description, /PlayStation Store gift card/);
  assert.match(embed.description, /satisfied with your experience/);
  assert.match(embed.description, /\[staff reviews\]\(https:\/\/discord\.com\/channels\/test-guild\/1554538609330225225\)/);
  assert.ok(embed.description.includes('\n\n' + icons.warning));
  assert.ok(!embed.description.includes('\n\n\n' + icons.warning), 'Please note uses the same spacing as other headings');
  assert.doesNotMatch(embed.description, /Rate us/);
  assert.doesNotMatch(embed.description, /DEMO-|Your review|Prize details/);
  assert.match(embed.description, /W90250885giveaway/);
  assert.match(embed.description, /W84starwhite/);
  assert.match(embed.description, /cloudy_claim_warning_white_sm1/);
  assert.match(embed.description, /W79heart4/);
  // Match the same one-space icon-to-heading gap as the other sections.
  assert.ok(embed.description.includes('Cloudy Inc.<a:W79heart4:1543304318470324324>'));
  assert.ok(embed.description.includes(icons.warning + '\u2009**Please note**'));
  assert.ok(!embed.description.includes(icons.warning + ' **Please note**'));
  assert.ok(!embed.description.includes(icons.warning + '**Please note**'));
  assert.ok(!embed.description.includes(icons.warning + '  **Please note**'));
  assert.doesNotMatch(embed.description, /Cloudy Inc\.\u202f<a:W79heart4/);
  const olderClaim = claimPanel({
    messageId: '123', guildId: 'test-guild', prize: 'VIP',
    claimReview: 'Thank you for helping Cloudy Inc. \u202f<a:W79heart4:1543304318470324324>',
  }, '456', icons).embeds[0];
  assert.ok(olderClaim.description.includes('Cloudy Inc.<a:W79heart4:1543304318470324324>'));
  assert.doesNotMatch(olderClaim.description, /Cloudy Inc\.\u202f<a:W79heart4/);
  assert.ok(embed.description.includes(icons.key + ' **How to get your prize**'));
  assert.ok(embed.description.includes(icons.info + ' **Prize conditions**'));
  const controls = panel.components[0].toJSON().components;
  assert.deepEqual(controls.map(item => item.label), ['Reveal my code', 'Close']);
  assert.deepEqual(controls.map(item => item.style), [2, 2]);
  assert.equal(controls[0].emoji.id, icons.key.split(':')[2].slice(0, -1));
  assert.equal(controls[1].emoji.id, icons.check.split(':')[2].slice(0, -1));
});
