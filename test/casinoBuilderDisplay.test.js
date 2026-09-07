import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';

import { buildEmbedPayload } from '../src/services/embedManagerService.js';
import {
  applyRuntimeEmbedTemplateData,
  cleanupSystemCatalogEntries,
  primeSystemEmbedTemplateData,
} from '../src/services/systemEmbedCatalogService.js';

function catalogRecord(index, key, title, context = null, extra = {}) {
  const gameContext = context || `gambling/${key.split(':')[1]}`;
  return {
    guildId: 'guild-casino-labels',
    channelId: 'channel-gambling',
    backingChannelId: 'channel-catalog',
    messageId: `catalog-${index}`,
    embedIndex: 0,
    source: 'system-catalog',
    title,
    name: title,
    createdAt: new Date(Date.UTC(2026, 8, 2, 16, index)).toISOString(),
    snapshot: {
      ...extra,
      title,
      author: {
        name: `Cloudy template key: ${key} || Cloudy context: ${gameContext} || Cloudy kind: embed`,
      },
    },
  };
}

function gamblingGuild() {
  const channel = {
    id: 'channel-gambling',
    name: '🎲│gambling',
    type: 0,
    messages: { fetch: async () => null },
    toString: () => '<#channel-gambling>',
  };
  return { channels: { cache: new Map([[channel.id, channel]]) } };
}

function menuOptions(payload) {
  const rows = payload.components.map(component => component.toJSON());
  return rows.flatMap(row => row.components || []).find(component => component.type === 3)?.options || [];
}

test('casino Builder preserves saved display names and stable catalog targets', () => {
  const definitions = [
    ['game:roulette:won', 'Roulette win'],
    ['game:roulette:lost', 'Roulette loss'],
    ['game:blackjack:bet', 'Blackjack bet'],
    ['game:blackjack:result:bust', 'Blackjack bust'],
    ['game:blackjack:result:blackjack', 'Blackjack natural win'],
    ['game:blackjack:result:win', 'Blackjack win'],
    ['game:blackjack:result:push', 'Blackjack push'],
    ['game:blackjack:result:loss', 'Blackjack loss'],
    ['game:blackjack:result:expired', 'Blackjack expired'],
    ['game:baccarat:bet', 'Baccarat bet'],
    ['game:baccarat:win', 'Baccarat win'],
    ['game:baccarat:loss', 'Baccarat loss'],
    ['game:baccarat:tie', 'Baccarat tie'],
    ['game:baccarat:expired', 'Baccarat expired'],
  ];
  const records = definitions.map(([key, label], index) => catalogRecord(
    index,
    key,
    key === 'game:roulette:lost'
      ? '<a:W85animatedarrowred:1543290732331270124> You lost'
      : `Custom ${label}`,
  ));

  const options = menuOptions(buildEmbedPayload(
    gamblingGuild(),
    records,
    'channel-gambling',
  ));

  assert.equal(options.length, records.length);
  for (const [index, record] of records.entries()) {
    const option = options.find(item => item.value === `catalog-${index}:0`);
    assert.ok(option, record.snapshot.author.name);
    assert.equal(option.label, record.title);
  }
});

test('existing legacy casino records stay available while preservation policy is active', () => {
  const emojiTitle = '<a:W85animatedarrowred:1543290732331270124> You lost';
  const cases = [
    ['game:roulette:lost', 'Roulette loss', 'gambling/roulette', {
      description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
      fields: [
        { name: 'Your bet', value: '{dynamic}' },
        { name: 'Result', value: '{dynamic}' },
        { name: 'Cash balance', value: '{dynamic}' },
      ],
    }],
    ['game:blackjack:result:loss', 'Blackjack loss', 'gambling/blackjack', {
      description: 'Payout: **{dynamic}**\nCash balance: **{dynamic}**',
      fields: [
        { name: 'Your Hand', value: '{dynamic}' },
        { name: 'Dealer Hand', value: '{dynamic}' },
      ],
    }],
    ['game:baccarat:loss', 'Baccarat loss', 'gambling/baccarat', {
      description: 'You chose **{dynamic}**. Winner: **{dynamic}**\nYou lost **{dynamic}**',
      fields: [
        { name: 'Player Hand', value: '{dynamic}' },
        { name: 'Banker Hand', value: '{dynamic}' },
      ],
    }],
  ];

  for (const [key, name, context, shape] of cases) {
    const records = [
      catalogRecord(0, key, name, context, shape),
      catalogRecord(1, 'embed:legacy-one', emojiTitle, 'gambling', shape),
      catalogRecord(2, 'embed:legacy-two', emojiTitle, 'gambling', shape),
    ];
    const options = menuOptions(buildEmbedPayload(
      gamblingGuild(),
      records,
      'channel-gambling',
    ));

    assert.equal(options.length, 3, context);
    assert.deepEqual(
      options.map(option => option.value).sort(),
      ['catalog-0:0', 'catalog-1:0', 'catalog-2:0'],
      context,
    );
  }
});

test('catalog cleanup leaves existing Roulette copies untouched while preservation policy is active', async () => {
  const emojiTitle = '<a:W85animatedarrowred:1543290732331270124> You lost';
  const makeMessage = (id, title, key, createdTimestamp) => ({
    id,
    createdTimestamp,
    embeds: [new EmbedBuilder({
      title,
      description: 'The wheel landed on {dynamic}\n**{dynamic} • {dynamic}**',
      fields: [
        { name: 'Your bet', value: '**{dynamic}** on **{dynamic}**', inline: true },
        { name: 'Result', value: 'Lost **{dynamic}**', inline: true },
        { name: 'Cash balance', value: '**{dynamic}**', inline: true },
      ],
      author: {
        name: `Cloudy template key: ${key} || Cloudy context: ${key.startsWith('game:') ? 'gambling/roulette' : 'gambling'} || Cloudy kind: embed`,
      },
    })],
    async edit() {
      assert.fail('Existing Roulette catalog message was rewritten');
    },
    async delete() {
      assert.fail('Existing Roulette catalog message was deleted');
    },
  });
  const messages = [
    makeMessage('roulette-canonical', 'Roulette loss', 'game:roulette:lost', 1),
    makeMessage('roulette-legacy-one', emojiTitle, 'embed:legacy-one', 2),
    makeMessage('roulette-legacy-two', emojiTitle, 'embed:legacy-two', 3),
  ];
  const before = JSON.stringify(messages.map(message => ({
    id: message.id,
    embeds: message.embeds.map(embed => embed.toJSON()),
  })));

  assert.equal(await cleanupSystemCatalogEntries(messages), false);
  assert.equal(messages.length, 3);
  assert.equal(JSON.stringify(messages.map(message => ({
    id: message.id,
    embeds: message.embeds.map(embed => embed.toJSON()),
  }))), before);
});

test('saved casino styling cannot change the semantic identity of a real result', () => {
  const cases = [
    {
      key: 'game:roulette:lost',
      context: 'gambling/roulette',
      commandName: 'roulette',
      runtime: {
        title: 'Roulette loss',
        description: 'The wheel landed on <:two:500000000000000002>\n**2 • Black**',
        fields: [
          { name: 'Your bet', value: '**$10** on **10**', inline: true },
          { name: 'Result', value: 'Lost **$10**', inline: true },
          { name: 'Cash balance', value: '**$90**', inline: true },
        ],
      },
    },
    {
      key: 'game:blackjack:result:loss',
      context: 'gambling/blackjack',
      commandName: 'blackjack',
      runtime: {
        title: 'Blackjack loss',
        description: 'Payout: **$0**\nCash balance: **$80**',
      },
    },
    {
      key: 'game:baccarat:loss',
      context: 'gambling/baccarat',
      commandName: 'baccarat',
      runtime: {
        title: 'Baccarat loss',
        description: 'You chose **player**. Winner: **banker**\nYou lost **$10**\nCash balance: **$70**',
      },
    },
  ];

  for (const item of cases) {
    primeSystemEmbedTemplateData(item.key, item.context, {
      ...item.runtime,
      title: '<a:W85animatedarrowred:1543290732331270124> You lost',
      color: 0x900003,
    });

    const rendered = applyRuntimeEmbedTemplateData(item.runtime, {
      commandName: item.commandName,
    });

    assert.equal(rendered.title, item.runtime.title);
    assert.equal(rendered.color, 0x670102);
    assert.equal(rendered.description, item.runtime.description);
  }
});
