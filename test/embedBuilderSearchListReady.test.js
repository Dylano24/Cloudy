import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import builder from '../src/commands/Tools/embedbuilder.js';
import * as search from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { warmSavedEmbedTemplateScopes } from '../src/services/embedTemplateService.js';

function fixture(t, suffix) {
  const guildId = 'search-list-ready-' + suffix;
  const channel = { id: '111111111111111781', name: 'general', permissionsFor: () => ({ has: () => true }) };
  const guild = { id: guildId, client: { user: { id: 'bot' } }, channels: { cache: new Map([[channel.id, channel]]) } };
  const record = { guildId, channelId: channel.id, messageId: '222222222222222782', embedIndex: 0,
    source: 'embed-builder', manualSaved: true, detached: true, components: [],
    title: 'Owner saved notice', snapshot: { title: 'Owner saved notice', description: 'Complete saved contents' } };
  t.mock.method(db, 'get', async (key, fallback) => key === 'cloudy:embed-registry:' + guildId ? [record] : fallback);
  const interaction = { guild, guildId, client: guild.client, user: { id: 'owner' }, member: { id: 'owner' },
    options: { getFocused: () => ({ name: 'search', value: '' }), getString: () => channel.id + ':' + record.messageId + ':0' },
    async respond(choices) { this.choices = choices; } };
  return { guild, record, interaction };
}

test('opening the native Search list immediately offers saved title choices before typing', async t => {
  const f = fixture(t, 'empty-focus');
  await getEmbedRegistry(f.guild.id);
  await warmSavedEmbedTemplateScopes(f.guild.id, [f.record.channelId]);
  await builder.autocomplete(f.interaction);
  assert.deepEqual(f.interaction.choices, [{ name: 'Owner saved notice', value: f.record.channelId + ':' + f.record.messageId + ':0' }]);
});

test('startup prewarming makes the first Search list complete without a query-time database read', async t => {
  const f = fixture(t, 'startup');
  assert.equal(typeof search.prewarmEmbedBuilderSearch, 'function');
  await search.prewarmEmbedBuilderSearch(f.guild);
  let reads = 0;
  t.mock.method(db, 'get', async (_key, fallback) => { reads++; return fallback; });
  await builder.autocomplete(f.interaction);
  assert.equal(f.interaction.choices[0]?.name, 'Owner saved notice');
  const selected = await search.loadEmbedBuilderSearchSelection(f.interaction);
  assert.equal(selected.record.messageId, f.record.messageId);
  assert.equal(selected.previewRecord.snapshot.description, 'Complete saved contents');
  assert.equal(reads, 0, 'the offered saved snapshot must not reload storage for its list or preview');
});

test('opening a large Search list avoids resolving each unchanged snapshot dozens of times', async t => {
  const f = fixture(t, 'large-list');
  await warmSavedEmbedTemplateScopes(f.guild.id, [f.record.channelId]);
  let reads = 0;
  const records = Array.from({ length: 1000 }, (_, index) => {
    const snapshot = { title: `Response ${index}`, description: `Complete response ${index}`,
      author: { name: `Cloudy template key: list-ready:${index}` } };
    return { ...f.record, source: 'system-catalog', manualSaved: false, title: snapshot.title,
      messageId: String(222222222222200000n + BigInt(index)), get snapshot() { reads++; return snapshot; } };
  });
  const choices = search.buildSearchChoices(search.buildAutocompleteMatches(f.guild, records, ''));
  assert.equal(choices.length, 25);
  assert.ok(reads < records.length * 7, `opening the list reread ${reads} snapshots for ${records.length} records`);
  assert.equal(search.buildSearchChoices(search.buildAutocompleteMatches(f.guild, records, 'Response 999'))[0]?.name, 'Response 999',
    'the initial 25 choices must not truncate the complete searchable index');
});
