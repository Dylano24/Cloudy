import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERIFIED_CLOUDY_TEXT,
  buildRestoredKnowledgePayloads,
  buildVerifiedCloudyFacts,
} from '../src/services/cloudyPublicKnowledgeService.js';

function textChannel(id, name) {
  return {
    id,
    name,
    guildId: '1532882647838228723',
    type: 0,
    isTextBased: () => true,
    isThread: () => false,
  };
}

function fixture() {
  const channels = [
    textChannel('rules-current', '📜│rules'),
    textChannel('link-current', '🔗│link-your-account'),
    textChannel('free-current', '🆓│free-kits'),
    textChannel('shop-current', '🛒│shop'),
    textChannel('store-current', '🛍️│cloudy-store'),
    textChannel('support-current', '✉️│contact-us'),
    textChannel('info-current', 'ℹ️│informations'),
  ];

  const cache = new Map(channels.map(channel => [channel.id, channel]));
  const guild = {
    id: '1532882647838228723',
    channels: {
      cache,
      fetch: async id => id ? cache.get(String(id)) || null : cache,
    },
  };
  const client = { channels: guild.channels };
  return { client, guild };
}

test('verified Cloudy knowledge preserves the retained September wording exactly', async () => {
  const { client, guild } = fixture();
  const facts = await buildVerifiedCloudyFacts(client, guild);

  assert.deepEqual(
    facts.navigation.map(item => [item.label, item.text]),
    [
      ['Rules', 'Check our rules'],
      ['Link your account', 'Claim free kits, purchases & alerts'],
      ['Subscriptions & Purchases', 'Cloudy Inc. website'],
      ['Support & Help', 'Contact us'],
    ],
  );

  assert.equal(facts.freeKits.verifiedInstruction, 'Claim free kits, purchases & alerts');
  assert.match(facts.freeKits.note, /Do not invent one/);
  assert.equal(Object.hasOwn(facts.freeKits, 'slashCommand'), false);
});

test('restored information panels use current Discord channels with only verified visible wording', async () => {
  const { client, guild } = fixture();
  const payloads = await buildRestoredKnowledgePayloads(client, guild);

  const information = payloads.informations.embeds[0].toJSON();
  assert.equal(information.title, undefined);
  assert.equal(information.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.deepEqual(information.fields.map(field => field.name), [
    VERIFIED_CLOUDY_TEXT.rulesLabel,
    VERIFIED_CLOUDY_TEXT.linkAccountLabel,
    VERIFIED_CLOUDY_TEXT.purchasesLabel,
    VERIFIED_CLOUDY_TEXT.supportLabel,
  ]);
  assert.match(information.fields[0].value, /rules-current/);
  assert.match(information.fields[1].value, /link-current/);
  assert.match(information.fields[2].value, /store-current/);
  assert.match(information.fields[3].value, /support-current/);

  const freeKits = payloads.freeKits.embeds[0].toJSON();
  assert.deepEqual(freeKits.fields, [{
    name: 'Link your account',
    value: '[Claim free kits, purchases & alerts](https://discord.com/channels/1532882647838228723/link-current)',
    inline: false,
  }]);
});
