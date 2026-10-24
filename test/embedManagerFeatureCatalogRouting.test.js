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

test('unsaved game, ticket and system responses remain in Search but not in Discord channel menus', () => {
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
    catalog('105', 'notice:too-fast', 'general/rate-limit', 'Too fast'),
  ];
  const original = structuredClone(records);
  const projected = projectCatalogTemplatesToFeatureChannels(guild, records);
  assert.deepEqual(records, original);
  assert.deepEqual(projected, [], 'no implicit channel association from a system template context');
  assert.ok(records.every(record => !isEmbedManagerVisibleRecord(record)));
  const options = buildEmbedPayload(guild, records, 'gambling-channel').components;
  assert.ok(options.every(row => row.components.every(c => c.data?.custom_id !== 'simple_embed_modify_embed:gambling-channel:0')));
  const overview = buildChannelPayload(guild, projected);
  const channelOptions = overview.components[0].components[0].options;
  assert.ok(channelOptions.some(c => c.data.value === 'gambling-channel'
    && c.data.description === 'No saved embed yet'));
});

test('only a deliberately saved catalog entry remains attached to its original channel', () => {
  const guild = {
    id: 'catalog-channel-test',
    channels: { cache: new Map([
      ['general', channel('general', 'general')],
      ['welcome', channel('welcome', 'welcome')],
      ['internal-log', channel('internal-log', 'botlog')],
    ]) },
  };
  const saved = { ...catalog('7', 'saved-example', 'general/example', 'Saved notice'),
    channelId: 'general', manualSaved: true };
  const projected = projectCatalogTemplatesToFeatureChannels(guild, [
    catalog('1', 'notice:too-fast', 'general/rate-limit', 'Too fast'),
    saved,
  ]);
  assert.deepEqual(projected.map(record => [record.messageId, record.channelId]), [['7', 'general']]);
  assert.ok(projected[0].catalogChannelProjection);
  assert.ok(isEmbedManagerVisibleRecord(projected[0]));
  assert.equal(projected[0].backingChannelId, 'internal-log');
  assert.ok(!projected.some(record => record.channelId === 'welcome'));
});
