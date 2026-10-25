import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import test from 'node:test';
import { preferWarmChannelFirstPage } from '../src/services/embedManagerService.js';

test('already fetched Discord embeds go straight into the first channel menu paint', async () => {
  const saved = [{ messageId: '123', channelId: 'gambling', snapshot: { title: 'Roulette win' } }];
  const result = await preferWarmChannelFirstPage(Promise.resolve(saved), 160);
  assert.equal(result.ready, true);
  assert.equal(result.found, saved, 'the fast path must retain the full existing snapshot and origin');
});

test('a slow Discord fetch never holds the first channel paint beyond its latency budget', async () => {
  const never = new Promise(() => {});
  const start = performance.now();
  const result = await preferWarmChannelFirstPage(never, 15);
  assert.equal(result.ready, false);
  assert.ok(performance.now() - start < 200, 'slow history must remain a background refresh');
});

test('channel first paint reuses a single history request and retains existing Save/Delete paths', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const start = source.indexOf("if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:'))");
  const end = source.indexOf("if (interaction.customId.startsWith('simple_embed_modify_embed_page:'))", start);
  const block = source.slice(start, end);
  assert.match(block, /const firstPagePromise = discoverRecentChannelEmbeds\(/);
  assert.match(block, /preferWarmChannelFirstPage\(firstPagePromise\)/);
  assert.match(block, /firstPage\.ready\s*\?\s*firstPage\.found\s*:\s*await firstPagePromise/);
  assert.match(block, /record\.manualSaved === true/);
  assert.match(block, /checking:\s*!firstPage\.ready && !hasKnownRecords/);
  assert.match(block, /discoverMissingChannelEmbeds\(/, 'full history is still scanned without holding first paint');
  assert.doesNotMatch(block, /saveEmbedTemplateDecoration|registerCloudyEmbedMessage|removeEmbedRegistryRecord/,
    'navigating a channel must never save, register or remove any embed');
});

test('Search autocomplete responds before warming only shortlisted template scopes', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const autocomplete = source.slice(
    source.indexOf('embedBuilderCommand.autocomplete = async function liveEmbedAutocomplete'),
    source.indexOf('const originalExecute = embedBuilderCommand.execute'),
  );
  assert.ok(autocomplete.includes('await interaction.respond(choices)'));
  assert.ok(autocomplete.indexOf('await interaction.respond(choices)')
    < autocomplete.indexOf('scheduleSearchSelectionScopeWarm(interaction.guildId, visibleMatches)'));
  assert.doesNotMatch(autocomplete.slice(0, autocomplete.indexOf('await interaction.respond(choices)')),
    /warmSavedEmbedTemplateScopes\(/, 'never block Search typing on a template DB scope');
  const helper = source.slice(
    source.indexOf('function scheduleSearchSelectionScopeWarm('),
    source.indexOf('// Discord autocomplete', source.indexOf('function scheduleSearchSelectionScopeWarm(')),
  );
  assert.match(helper, /\.slice\(0, 6\)/);
  assert.match(helper, /15_000/);
  assert.match(helper, /warmSavedEmbedTemplateScopes\(id, channels\)/);
});
