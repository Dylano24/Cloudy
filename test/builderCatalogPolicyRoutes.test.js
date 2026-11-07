import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import {
  ensureBuilderCatalogDecisionsLoaded,
  getSystemEmbedTemplateKey,
  rememberCatalogSourceEvidence,
} from '../src/services/systemEmbedCatalogService.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes } from '../src/services/embedTemplateService.js';
import { loadFastEmbedBuilderSearchRecords } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { isEmbedManagerVisibleRecord } from '../src/services/embedManagerService.js';
import { isBuilderRecordAdmitted, savedOverlayMatch } from '../src/services/builderCatalogAdmission.js';

// Builder admission (owner's choice): Search (warm or cached), Modify and an
// offered choice apply one rule; a title never admits another family.
const values = new Map();
function resetDb() {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => { values.delete(key); return true; },
  };
}

// Two unchanged TitanBot examples (an optional feature) that share one title.
const upstreamDefinitions = [
  { kind: 'embed', title: 'Settings saved', description: 'Leveling settings were saved.', context: 'botlog/level-dashboard',
    variantId: 'commands/Leveling/modules/level_dashboard.js:embed:1:settings-saved' },
  { kind: 'embed', title: 'Settings saved', description: 'Todo settings were saved.', context: 'botlog/todo',
    variantId: 'commands/Utility/todo.js:embed:1:settings-saved' },
];
const keyOf = definition => getSystemEmbedTemplateKey('embed', definition.title, definition.description, definition.context);
let nextId = 1532882647838230000n;
function catalogRecord(guildId, definition, extra = {}) {
  nextId += 1n;
  return {
    guildId, channelId: 'feature', backingChannelId: 'botlog', messageId: String(nextId), embedIndex: 0,
    source: 'system-catalog', title: definition.title, name: definition.title, createdAt: '2026-11-07T06:00:00.000Z',
    snapshot: { title: definition.title, description: definition.description, color: 0xFFFFFF,
      author: { name: `Cloudy template key: ${keyOf(definition)} || Cloudy context: ${definition.context} || Cloudy kind: embed` } },
    ...extra,
  };
}

async function setup(guildId, records) {
  resetDb();
  values.set(`cloudy:embed-registry:${guildId}`, records);
  // These two count as unchanged originals of the old code.
  const { templateTextSignature } = await import('../src/services/builderCatalogPolicy.js');
  rememberCatalogSourceEvidence(upstreamDefinitions, {
    upstreamSignatures: new Set(upstreamDefinitions.map(templateTextSignature)),
  });
  await ensureBuilderCatalogDecisionsLoaded(guildId);
  await getEmbedRegistry(guildId, { cached: true });
  await warmSavedEmbedTemplateScopes(guildId, ['feature']);
  const guild = { id: guildId, channels: { cache: new Map() }, members: { me: null } };
  return {
    guild,
    titles: async () => (await loadFastEmbedBuilderSearchRecords({ guild, guildId, member: null }, { unfiltered: true }))
      .map(record => `${record.snapshot.description}`).sort(),
  };
}

test('unchanged optional examples stay out; a change saved for one family admits only that family', async () => {
  const guildId = 'routes-title-collision';
  const [leveling, todo] = upstreamDefinitions.map(definition => catalogRecord(guildId, definition));
  const { titles } = await setup(guildId, [leveling, todo]);
  assert.deepEqual(await titles(), [], 'both unchanged examples are archived');

  // A saved change keyed to the leveling family only (e.g. only a new colour).
  await saveEmbedTemplateDecoration(guildId, 'feature', [keyOf(upstreamDefinitions[0])],
    { ...leveling.snapshot, color: 0xFF0080 }, { canonicalIdentity: keyOf(upstreamDefinitions[0]) });
  assert.equal(savedOverlayMatch(leveling), 'family');
  assert.equal(savedOverlayMatch(todo), 'ambiguous-title', 'the shared title proves nothing for todo');
  assert.deepEqual(await titles(), ['Leveling settings were saved.'], 'the cached Search list is rebuilt at once');

  // A change saved only under the shared title proves nothing for either family.
  resetDb();
  const second = await setup('routes-title-only', [
    catalogRecord('routes-title-only', upstreamDefinitions[0]),
    catalogRecord('routes-title-only', upstreamDefinitions[1]),
  ]);
  await saveEmbedTemplateDecoration('routes-title-only', 'feature', ['Settings saved'], { title: 'Settings saved', color: 0x00FF00 });
  assert.deepEqual(await second.titles(), [], 'a shared title never admits a family');
});

test('an explicit Save on any stored copy admits the in-memory copy of the same embed', async () => {
  const guildId = 'routes-owner-copy';
  const saved = catalogRecord(guildId, upstreamDefinitions[1], { manualSaved: true, explicitSave: true });
  const { titles } = await setup(guildId, [saved]);
  assert.deepEqual(await titles(), ['Todo settings were saved.']);
  // The catalog's in-memory copy carries no flags: the registry copy counts.
  const { manualSaved, explicitSave, ...memoryCopy } = saved;
  assert.ok(manualSaved && explicitSave);
  assert.equal(isBuilderRecordAdmitted(memoryCopy), true);
});

test('Modify uses the same admission as Search', async () => {
  const guildId = 'routes-modify';
  const archived = catalogRecord(guildId, upstreamDefinitions[0]);
  const own = catalogRecord(guildId, upstreamDefinitions[1], { manualSaved: true, explicitSave: true });
  await setup(guildId, [archived, own]);
  assert.equal(isEmbedManagerVisibleRecord(archived), false);
  assert.equal(isEmbedManagerVisibleRecord(own), true);
  // Real messages are never affected.
  assert.equal(isEmbedManagerVisibleRecord({ ...archived, source: 'cloudy', backingChannelId: 'feature' }), true);
});

test('a legacy save flag stays listed once everything is loaded, but not on a cold start', async () => {
  const guildId = 'routes-legacy-save';
  const legacy = catalogRecord(guildId, upstreamDefinitions[0], { manualSaved: true });
  const { titles } = await setup(guildId, [legacy]);
  assert.deepEqual(await titles(), ['Leveling settings were saved.'], 'possible own work is kept visible for review');
  const cold = { ...legacy, guildId: 'routes-legacy-cold', channelId: 'never-loaded' };
  assert.equal(isBuilderRecordAdmitted(cold), false, 'cold start: only proven own work and approved templates');
});
