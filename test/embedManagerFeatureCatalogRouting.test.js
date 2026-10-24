import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectCatalogTemplatesToFeatureChannels,
  isEmbedManagerVisibleRecord,
  buildChannelPayload,
  buildEmbedPayload,
} from '../src/services/embedManagerService.js';

const channel = (id, name) => ({
  id, name, type: 0, rawPosition: 1,
  messages: { fetch: async () => new Map() },
  toString: () => '#'+name,
});

function catalog(id, key, context, title) {
  return {
    guildId: 'catalog-channel-test', channelId: 'internal-log', backingChannelId: 'internal-log',
    messageId: id, embedIndex: 0, source: 'system-catalog', name: title, title,
    snapshot: {
      title, description: 'Original bot source template', color: 0xffffff,
      author: { name: `Cloudy template key: ${key} || Cloudy context: ${context} || Cloudy kind: embed` },
    },
  };
}

test('channel browser routes all source-defined gambling and ticket templates into their actual feature channels without posting ghost messages', () => {
  const guild = {
    id: 'catalog-channel-test',
    channels: { cache: new Map([
      ['gambling-channel', channel('gambling-channel', '🎲 | gambling')],
      ['ticket-log-channel', channel('ticket-log-channel', 'ticket-logs')],
      ['general', channel('general', 'general')],
      ['internal-log', channel('internal-log', 'botlog')],
    ]) },
  };
  const records = [
    catalog('101', 'game:roulette:won', 'gambling/roulette', 'Roulette win'),
    catalog('102', 'game:roulette:lost', 'gambling/roulette', 'Roulette loss'),
    catalog('103', 'ticket-log:open', 'ticket-logs/open', 'Ticket created'),
    catalog('104', 'builder:removed', 'embed-builder/delete', 'Removed from Builder'),
  ];
  const original = structuredClone(records);
  const projected = projectCatalogTemplatesToFeatureChannels(guild, records);
  assert.deepEqual(records, original, 'source records and backing storage must remain unchanged');
  assert.deepEqual(projected.map(x => [x.messageId, x.channelId]), [
    ['101', 'gambling-channel'], ['102', 'gambling-channel'], ['103', 'ticket-log-channel'],
  ]);
  assert.ok(projected.every(x => x.backingChannelId === 'internal-log'
    && x.source === 'system-catalog' && x.catalogChannelProjection === true
    && isEmbedManagerVisibleRecord(x)));
  const overview = buildChannelPayload(guild, projected);
  const options = overview.components[0].components[0].options;
  assert.ok(options.some(x => x.data.value === 'gambling-channel'
    && x.data.description !== 'No saved embed yet'));
  const gambling = buildEmbedPayload(guild, projected, 'gambling-channel');
  const gamblingOptions = gambling.components[0].components[0].options;
  assert.deepEqual(gamblingOptions.map(x => x.data.label), ['Roulette win', 'Roulette loss']);
});

test('catalog mapping does not invent channel messages or leak unrelated source definitions into similarly named channels', () => {
  const guild = {
    id: 'catalog-channel-test',
    channels: { cache: new Map([
      ['general', channel('general', 'general')],
      ['games', channel('games', 'games')],
      ['internal-log', channel('internal-log', 'botlog')],
    ]) },
  };
  const result = projectCatalogTemplatesToFeatureChannels(guild, [
    catalog('1', 'game:roulette:won', 'gambling/roulette', 'Roulette win'),
    catalog('2', 'builder:removed', 'embed-builder/delete', 'Removed from Builder'),
    catalog('3', 'ticket-log:open', 'ticket-logs/open', 'Ticket created'),
  ]);
  assert.equal(result.length, 0, 'no arbitrary fallback channel may receive a catalog template');
});
