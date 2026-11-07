import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import {
  ensureUsedBuilderCatalogLoaded,
  getSystemEmbedTemplateKey,
  markBuilderCatalogUsed,
  rememberCodeDiscoveredCatalogKeys,
} from '../src/services/systemEmbedCatalogService.js';
import { loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

// Owner's choice: Search lists only what is really used. A reply that only
// exists in Cloudy's code appears once Cloudy has sent it in the server.
const guildId = 'search-used-only-guild';
const channelId = '1532882647838229001';
const code = [
  { kind: 'embed', context: 'botlog/todo', title: 'Todo list', description: 'Your todo list is empty.' },
  { kind: 'embed', context: 'welcome/greet-dashboard', title: 'Welcome image updated', description: 'The welcome image was updated.' },
  { kind: 'embed', context: 'botlog/level-dashboard', title: 'Leveling configured', description: 'Leveling settings saved.' },
  { kind: 'embed', context: 'tickets/ticket', title: 'Ticket closed', description: 'This ticket was closed.' },
];
const keyOf = definition => getSystemEmbedTemplateKey('embed', definition.title, definition.description, definition.context);

let nextId = 1532882647838229100n;
function catalogRecord(definition, extra = {}) {
  nextId += 1n;
  const key = keyOf(definition);
  return {
    guildId, channelId, messageId: String(nextId), embedIndex: 0, source: 'system-catalog',
    title: definition.title, name: definition.title,
    snapshot: {
      title: definition.title, description: definition.description, color: 0xFFFFFF,
      author: { name: `Cloudy template key: ${key} || Cloudy context: ${definition.context} || Cloudy kind: embed` },
    },
    createdAt: '2026-11-07T06:00:00.000Z', ...extra,
  };
}

test('Search shows real posts, notifications and sent replies; never-used code replies stay out', async t => {
  rememberCodeDiscoveredCatalogKeys(code);
  const records = [
    catalogRecord(code[0]),
    catalogRecord(code[1]),
    catalogRecord(code[2], { manualSaved: true }),
    catalogRecord(code[3]),
    catalogRecord({ kind: 'embed', context: 'gambling', title: 'Wrong channel',
      description: 'This command can only be used in the dedicated channel. Please use {dynamic} to play.' }),
    { guildId, channelId, messageId: '1532882647838229999', embedIndex: 0, source: 'embed-builder', manualSaved: true,
      title: 'Server rules', name: 'Server rules', snapshot: { title: 'Server rules', description: 'Be nice.' },
      createdAt: '2026-11-07T06:00:00.000Z' },
  ];
  // The welcome image reply was really sent before.
  const stored = new Map([
    ['cloudy:embed-registry:' + guildId, records],
    ['cloudy:embed-builder-used-catalog:' + guildId, [keyOf(code[1]).toLowerCase()]],
  ]);
  t.mock.method(db, 'get', async (key, fallback) => (stored.has(key) ? structuredClone(stored.get(key)) : fallback ?? null));
  t.mock.method(db, 'set', async (key, value) => { stored.set(key, structuredClone(value)); return true; });
  await getEmbedRegistry(guildId, { cached: true });
  await ensureUsedBuilderCatalogLoaded(guildId);

  const guild = { id: guildId, channels: { cache: new Map() }, members: { me: null } };
  const titles = async () => (await loadFastEmbedBuilderSearchRecords(
    { guild, guildId, member: null }, { unfiltered: true },
  )).map(record => record.title).sort();

  assert.deepEqual(await titles(), [
    'Leveling configured', // saved in the Builder
    'Server rules', // a real Builder post
    'Ticket closed', // ticket templates always stay
    'Welcome image updated', // really sent
    'Wrong channel', // a fixed notification
  ], 'the never-used Todo reply is not listed');

  // Once Cloudy really sends it, it appears at once.
  assert.equal(markBuilderCatalogUsed(guildId, keyOf(code[0])), true);
  assert.ok((await titles()).includes('Todo list'));
});

test('a database error never hides anything: Search then shows everything', async t => {
  const other = 'search-used-only-db-error';
  rememberCodeDiscoveredCatalogKeys(code);
  t.mock.method(db, 'get', async key => {
    if (key.startsWith('cloudy:embed-builder-used-catalog:')) throw new Error('database offline');
    if (key === 'cloudy:embed-registry:' + other) return [{ ...catalogRecord(code[0]), guildId: other }];
    return null;
  });
  await getEmbedRegistry(other, { cached: true });
  await ensureUsedBuilderCatalogLoaded(other).catch(() => null);
  const guild = { id: other, channels: { cache: new Map() }, members: { me: null } };
  const records = await loadFastEmbedBuilderSearchRecords({ guild, guildId: other, member: null }, { unfiltered: true });
  assert.deepEqual(records.map(record => record.title), ['Todo list']);
});

test('a code reply that is really posted in the server stays listed (panels and guides from before)', async t => {
  const other = 'search-used-only-posted';
  rememberCodeDiscoveredCatalogKeys([...code, { kind: 'embed', context: 'botlog/zorp-guide-service', title: 'ZORP Guide', description: 'How ZORP works.' }]);
  const guide = { ...catalogRecord({ kind: 'embed', context: 'botlog/zorp-guide-service', title: 'ZORP Guide', description: 'How ZORP works.' }), guildId: other };
  const posted = { guildId: other, channelId, messageId: '1532882647838229777', embedIndex: 0, source: 'cloudy',
    title: '📘 ZORP Guide', name: 'ZORP Guide', snapshot: { title: '📘 ZORP Guide', description: 'How ZORP works.' },
    createdAt: '2026-11-01T06:00:00.000Z' };
  const todo = { ...catalogRecord(code[0]), guildId: other };
  const stored = new Map([['cloudy:embed-registry:' + other, [guide, posted, todo]]]);
  t.mock.method(db, 'get', async (key, fallback) => (stored.has(key) ? structuredClone(stored.get(key)) : fallback ?? null));
  t.mock.method(db, 'set', async () => true);
  await getEmbedRegistry(other, { cached: true });
  await ensureUsedBuilderCatalogLoaded(other);
  const guild = { id: other, channels: { cache: new Map() }, members: { me: null } };
  const records = await loadFastEmbedBuilderSearchRecords({ guild, guildId: other, member: null }, { unfiltered: true });
  const sources = records.map(record => `${record.source}:${record.title}`).sort();
  assert.deepEqual(sources, ['cloudy:📘 ZORP Guide', 'system-catalog:ZORP Guide'],
    'the posted guide keeps its Search entry; the never-used Todo reply does not');
});
