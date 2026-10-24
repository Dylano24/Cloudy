import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverEmbedDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { getBuiltInSystemCatalogDefinitions } from '../src/services/systemEmbedCatalogService.js';
import {
  buildMatches,
  buildSearchChoices,
  recordTitle,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const FORBIDDEN = /\b(?:botlog|bot log|report logs?|variant\s+\d+)\b|\(\d+\)$|\b\d{15,}\b|\{dynamic\}/i;

function fakeRecord(definition, index) {
  const kind = String(definition.kind || 'embed').toLowerCase();
  const title = kind === 'content'
    ? String(definition.label || 'Cloudy response')
    : String(definition.title || 'Cloudy response');
  const context = String(definition.context || 'botlog');
  const key = String(definition.key || definition.variantId || `audit:${index}`);

  return {
    guildId: 'global-commercial-search-audit',
    channelId: '100000000000000001',
    backingChannelId: '100000000000000099',
    messageId: String(910000000000000000n + BigInt(index)),
    embedIndex: 0,
    source: 'system-catalog',
    name: title,
    title,
    snapshot: {
      title,
      description: definition.description || definition.content || undefined,
      fields: definition.fields || [],
      footer: definition.footer || null,
      color: definition.color,
      author: {
        name: `Cloudy template key: ${key} || Cloudy context: ${context} || Cloudy kind: ${kind}`,
      },
    },
  };
}

const guild = {
  id: 'global-commercial-search-audit',
  channels: {
    cache: new Map([[
      '100000000000000001',
      { id: '100000000000000001', name: 'cloudy', parent: null },
    ]]),
  },
};

test('combined Search catalog emits only unique clean commercial choice names', async () => {
  const builtIns = getBuiltInSystemCatalogDefinitions();
  const discovered = await discoverEmbedDefinitions();
  const definitions = [...builtIns, ...discovered];
  assert.ok(definitions.length > 100, 'commercial audit should cover the real response catalog');

  const records = definitions.map(fakeRecord);
  const matches = buildMatches(guild, records, '');
  const choices = buildSearchChoices(matches);

  assert.ok(choices.length > 50, 'Search must expose a substantial reusable response catalog');
  assert.equal(
    new Set(choices.map(choice => choice.name.toLowerCase())).size,
    choices.length,
    'Search choice names must be unique without suffix hacks',
  );

  for (const choice of choices) {
    assert.ok(choice.name.trim(), 'Search choice name must not be empty');
    assert.doesNotMatch(choice.name, FORBIDDEN, `non-commercial Search name: ${choice.name}`);
    assert.match(choice.value, /^\d+:\d+:\d+$/, `invalid Search selection value for ${choice.name}`);
  }
});

test('every reusable catalog definition remains discoverable by its commercial title', async () => {
  const definitions = [
    ...getBuiltInSystemCatalogDefinitions(),
    ...(await discoverEmbedDefinitions()),
  ];
  const records = definitions.map(fakeRecord);

  let checked = 0;
  for (const record of records) {
    const query = recordTitle(record);
    if (!query) continue;
    checked += 1;

    const matches = buildMatches(guild, records, query);
    const choices = buildSearchChoices(matches);
    assert.ok(
      choices.length > 0,
      `no Search result for reusable response "${query}"`,
    );
    assert.ok(
      choices.some(choice => choice.name.toLowerCase().includes(query.toLowerCase())
        || query.toLowerCase().includes(choice.name.toLowerCase())),
      `Search did not surface a matching commercial name for "${query}"`,
    );
  }

  assert.ok(checked > 100, 'discoverability audit must cover the real catalog');
});
