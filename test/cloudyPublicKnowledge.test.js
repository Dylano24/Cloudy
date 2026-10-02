import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUDY_KNOWLEDGE_FOOTER,
  buildVerifiedCloudyFacts,
  cleanupGeneratedKnowledgePanels,
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
  return { client, guild, cache };
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

test('standalone knowledge panels are never recreated and only tracked bot panels are removed', async () => {
  const { client, guild, cache } = fixture();
  const deleted = [];
  const deletedKeys = [];

  for (const channelId of ['info-current', 'link-current', 'free-current']) {
    const channel = cache.get(channelId);
    channel.messages = {
      fetch: async messageId => ({
        id: messageId,
        author: { id: 'bot' },
        embeds: [{ footer: { text: CLOUDY_KNOWLEDGE_FOOTER } }],
        delete: async () => {
          deleted.push(messageId);
        },
      }),
    };
  }

  const tracked = new Map([
    ['global:cloudy:verified-knowledge-panel:info-current', 'msg-info'],
    ['global:cloudy:verified-knowledge-panel:link-current', 'msg-link'],
    ['global:cloudy:verified-knowledge-panel:free-current', 'msg-free'],
  ]);

  client.user = { id: 'bot' };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  client.db = {
    get: async key => tracked.get(key) || null,
    delete: async key => {
      deletedKeys.push(key);
      tracked.delete(key);
    },
  };

  const results = await cleanupGeneratedKnowledgePanels(client);

  assert.equal(results.filter(result => result.removed).length, 3);
  assert.deepEqual(deleted.sort(), ['msg-free', 'msg-info', 'msg-link']);
  assert.equal(deletedKeys.length, 3);
  assert.equal(tracked.size, 0);
});
