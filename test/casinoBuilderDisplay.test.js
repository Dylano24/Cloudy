import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbedPayload } from '../src/services/embedManagerService.js';
import {
  applyRuntimeEmbedTemplateData,
  primeSystemEmbedTemplateData,
} from '../src/services/systemEmbedCatalogService.js';

function catalogRecord(index, key, title) {
  const game = key.split(':')[1];
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
      title,
      author: {
        name: `Cloudy template key: ${key} || Cloudy context: gambling/${game} || Cloudy kind: embed`,
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

test('casino templates use stable game names and render custom emoji without exposing its name', () => {
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
  const byLabel = new Map(options.map(option => [option.label, option]));

  assert.deepEqual(
    [...byLabel.keys()].sort(),
    definitions.map(([, label]) => label).sort(),
  );
  assert.deepEqual(byLabel.get('Roulette loss').emoji, {
    id: '1543290732331270124',
    name: 'W85animatedarrowred',
    animated: true,
  });
  assert.equal(options.some(option => /W85animatedarrowred|<a?:/i.test(option.label)), false);
});

test('saved casino titles are applied to the next real channel result while live values stay dynamic', () => {
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
      title: '<a:W85animatedarrowred:1543290732331270124> My roulette loss',
    },
    {
      key: 'game:blackjack:result:loss',
      context: 'gambling/blackjack',
      commandName: 'blackjack',
      runtime: {
        title: 'Blackjack loss',
        description: 'Payout: **$0**\nCash balance: **$80**',
      },
      title: 'My blackjack loss',
    },
    {
      key: 'game:baccarat:loss',
      context: 'gambling/baccarat',
      commandName: 'baccarat',
      runtime: {
        title: 'Baccarat loss',
        description: 'You chose **player**. Winner: **banker**\nYou lost **$10**\nCash balance: **$70**',
      },
      title: 'My baccarat loss',
    },
  ];

  for (const item of cases) {
    primeSystemEmbedTemplateData(item.key, item.context, {
      ...item.runtime,
      title: item.title,
      color: 0x900003,
    });

    const rendered = applyRuntimeEmbedTemplateData(item.runtime, {
      commandName: item.commandName,
    });

    assert.equal(rendered.title, item.title);
    assert.equal(rendered.color, 0x900003);
    assert.equal(rendered.description, item.runtime.description);
  }
});
