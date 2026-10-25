import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/utils/database.js';
import { hideSystemCatalogFromBuilder, isSystemCatalogHiddenFromBuilder } from '../src/services/systemEmbedCatalogService.js';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function guildWith(...channels) {
  return {
    channels: {
      cache: new Map(channels.map(name => [
        name,
        { id: name, name, parent: null },
      ])),
    },
  };
}

function record({
  id,
  source = 'cloudy',
  channelId = 'botlog',
  title = 'Task Removed',
  description = 'Task removed from #botlog.',
  author = null,
}) {
  return {
    guildId: 'guild',
    channelId,
    messageId: id,
    embedIndex: 0,
    source,
    title,
    name: title,
    snapshot: {
      title,
      description,
      ...(author ? { author: { name: author } } : {}),
    },
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
  };
}

test('Search collapses automated peers that differ only by technical catalog metadata', () => {
  const guild = guildWith('botlog');
  const records = [
    record({ id: '1', source: 'cloudy' }),
    record({
      id: '2',
      source: 'system-catalog',
      author: 'Cloudy template key: embed-type:abc123 || Cloudy context: botlog || Cloudy kind: embed',
    }),
    record({ id: '3', source: 'modified' }),
  ];

  const matches = buildMatches(guild, records, 'task removed');
  assert.equal(matches.length, 1);
});

test('Search shows only one title for different bot messages with the same title', () => {
  const guild = guildWith('botlog');
  const matches = buildMatches(guild, [
    record({ id: '10', description: 'Scheduled task removed from #botlog.' }),
    record({ id: '11', description: 'Verification task removed from #botlog.' }),
    record({ id: '12', description: 'Role reward task removed from #botlog.' }),
  ], 'task removed');

  assert.equal(matches.length, 3, 'underlying message/preview records must be retained');
  const choices = buildSearchChoices(matches);
  assert.deepEqual(choices.map(choice => choice.name), ['Task removed']);
  assert.ok(choices.every(choice => !/Scheduled|Verification|Role reward/i.test(choice.name)));
  assert.equal(matches[0].record.snapshot.description, 'Scheduled task removed from #botlog.');
});

test('Search shows one result for two identical manual embeds', () => {
  const guild = guildWith('general');
  const matches = buildMatches(guild, [
    record({
      id: '123456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
    record({
      id: '223456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
  ], 'custom panel');

  assert.equal(matches.length, 1);
  const choices = buildSearchChoices(matches);
  assert.deepEqual(choices.map(choice => choice.name), ['Custom panel']);
});

test('Search keeps useful system/error templates and hides history mirrors', () => {
  const guild = guildWith('gambling', 'botlog');
  const matches = buildMatches(guild, [
    record({
      id: 'catalog-invalid',
      source: 'system-catalog',
      channelId: 'gambling',
      title: 'Invalid Input',
      description: 'Please check your input and try again.',
      author: 'Cloudy template key: invalid input || Cloudy context: gambling || Cloudy kind: embed',
    }),
    record({
      id: 'history-invalid',
      source: 'bot-history',
      channelId: 'gambling',
      title: 'Invalid Input',
      description: 'Please check your input and try again.',
    }),
  ], 'invalid');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Invalid input');
});


test('Search collapses runtime copies that differ only by dynamic IDs or task keys', () => {
  const guild = guildWith('botlog');
  const matches = buildMatches(guild, [
    record({
      id: '101',
      description: 'Task daily-reward was removed by <@111111111111111111>.',
    }),
    record({
      id: '102',
      description: 'Task cleanup-cache was removed by <@222222222222222222>.',
    }),
    record({
      id: '103',
      description: 'Task backup-logs was removed by <@333333333333333333>.',
    }),
  ], 'task removed');

  assert.equal(matches.length, 1);
});

test('Search never invents duplicate suffixes or exposes raw message IDs', () => {
  const guild = guildWith('general');
  const matches = buildMatches(guild, [
    record({
      id: '123456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
    record({
      id: '223456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
  ], 'custom panel');

  const names = buildSearchChoices(matches).map(choice => choice.name);
  assert.deepEqual(names, ['Custom panel']);
  assert.ok(names.every(name => !/\(\d+\)$/i.test(name)));
  assert.ok(names.every(name => !/Variant\s+\d+/i.test(name)));
  assert.ok(names.every(name => !/345678/.test(name)));
});

test('repeated Ping latency responses share one Search template despite changing measurements', () => {
  const guild = guildWith('botlog');
  const ping = (id, milliseconds) => record({
    id,
    source: 'system-catalog',
    title: 'Ping!',
    description: `Bot latency: ${milliseconds}ms\nAPI latency: 24ms`,
    author: `Cloudy template key: source:ping-${id} || Cloudy context: core/ping || Cloudy kind: embed`,
  });
  const matches = buildMatches(guild, [ping('101', 88), ping('102', 99), ping('103', 117)], 'ping');
  assert.equal(matches.length, 1, 'runtime measurements must not create new Builder options');
  assert.equal(buildSearchChoices(matches).length, 1);
});

test('removing a system-catalog entry persists a Builder-only hide without deleting the template source', async t => {
  const data = new Map();
  t.mock.method(db, 'get', async key => structuredClone(data.get(key) ?? []));
  t.mock.method(db, 'set', async (key, value) => {
    data.set(key, structuredClone(value));
    return true;
  });

  const guildId = 'hidden-builder-catalog-test';
  const item = {
    guildId,
    source: 'system-catalog',
    channelId: '111111111111111111',
    messageId: '222222222222222222',
    embedIndex: 0,
    title: 'Ping!',
    snapshot: {
      title: 'Ping!',
      description: 'Bot latency: 99ms',
      author: { name: 'Cloudy template key: source:ping-runtime || Cloudy context: core/ping || Cloudy kind: embed' },
    },
  };

  assert.equal(isSystemCatalogHiddenFromBuilder(item), false);
  assert.equal(buildMatches(guildWith('111111111111111111'), [item], 'ping').length, 1);
  assert.equal(await hideSystemCatalogFromBuilder(guildId, { ...item, sourceEmbedData: item.snapshot }), true);
  assert.equal(isSystemCatalogHiddenFromBuilder(item), true);
  const olderPing = {
    ...item,
    messageId: '333333333333333333',
    snapshot: {
      ...item.snapshot,
      description: 'Bot latency: 88ms',
      author: { name: 'Cloudy template key: source:older-ping || Cloudy context: core/ping || Cloudy kind: embed' },
    },
  };
  assert.equal(isSystemCatalogHiddenFromBuilder(olderPing), true,
    'deleting one Ping result must not expose an older catalog copy');
  assert.equal(buildMatches(guildWith('111111111111111111'), [item, olderPing], 'ping').length, 0);
  assert.ok(data.has('cloudy:embed-builder-hidden-catalog:' + guildId),
    'visibility preference must be stored durably, not only removed from the in-memory Search list');
  assert.equal(item.snapshot.description, 'Bot latency: 99ms', 'runtime definition remains untouched');
});


test('a deleted catalog response does not reappear through modified or physical Search mirrors', async t => {
  const storage = new Map();
  t.mock.method(db, 'get', async key => structuredClone(storage.get(key) || []));
  t.mock.method(db, 'set', async (key, value) => {
    storage.set(key, structuredClone(value));
    return true;
  });
  const guildId = 'hidden-catalog-mirror-search-20261025';
  const author = 'Cloudy template key: source:assistant-visible || Cloudy context: faq/assistant || Cloudy kind: embed';
  const catalog = {
    ...record({ id: '100000000000000111', source: 'system-catalog', title: 'Ask Cloudy',
      description: 'An assistance message', author }),
    guildId,
  };
  const other = {
    ...catalog,
    messageId: '100000000000000112', source: 'modified-template',
    manualSaved: true, snapshot: { ...catalog.snapshot },
  };
  const separateManual = {
    ...catalog,
    messageId: '100000000000000113', source: 'embed-builder',
    manualSaved: true, snapshot: { ...catalog.snapshot },
  };
  const guild = guildWith('botlog');
  assert.equal(await hideSystemCatalogFromBuilder(guildId, catalog), true);
  assert.equal(isSystemCatalogHiddenFromBuilder(catalog), true);
  const matches = buildMatches(guild, [catalog, other, separateManual], 'ask cloudy');
  assert.equal(matches.length, 1, 'catalog and modified mirrors must stay hidden');
  assert.equal(matches[0].record.messageId, separateManual.messageId,
    'an independent manually posted embed is not deleted or hidden');
});

test('Search excludes content-only bot templates whose generated labels copy their body', () => {
  const guild = guildWith('botlog');
  const items = [
    record({ id: '100000000000001111', source: 'system-catalog',
      title: 'Ask Cloudy anything from technical Cloudy problems and bot errors to programming',
      description: 'Ask Cloudy anything from technical Cloudy problems and bot errors to programming, troubleshooting.',
      author: 'Cloudy template key: source:plain-assistant || Cloudy context: assistant/ask || Cloudy kind: content' }),
    record({ id: '100000000000001112', source: 'modified-template',
      title: 'Ask Cloudy anything from technical Cloudy problems and bot errors to programming',
      author: 'Cloudy template key: source:plain-assistant || Cloudy context: assistant/ask || Cloudy kind: content' }),
    record({ id: '100000000000001113', source: 'system-catalog',
      title: 'Permission denied', description: 'You cannot do that.',
      author: 'Cloudy template key: permission-denied || Cloudy context: botlog || Cloudy kind: embed' }),
  ];
  assert.equal(buildMatches(guild, items, 'ask cloudy').length, 0);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, items, 'permission denied')).map(x => x.name),
    ['Permission denied']);
  assert.equal(items[0].snapshot.description.includes('troubleshooting'), true,
    'the underlying response content remains untouched');
});
