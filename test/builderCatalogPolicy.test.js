import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBuilderRecord,
  isBuilderDecisionVisible,
  ownerEvidence,
  templateMetadata,
  templateTextSignature,
} from '../src/services/builderCatalogPolicy.js';
import {
  RETIRED_SOURCE_FILES,
  RETIRED_TEMPLATE_FAMILIES,
  UPSTREAM_TEMPLATE_SIGNATURES,
  isApprovedFeatureContext,
  isApprovedUpstreamSourcePath,
  isRetiredSourcePath,
} from '../src/config/builderCatalogManifest.js';

// Builder admission (owner's choice): own work and Cloudy's templates stay,
// unchanged TitanBot examples and retired command templates go.
const catalog = (key, context, extra = {}) => ({
  guildId: 'policy-guild', channelId: 'botlog', backingChannelId: 'botlog', messageId: '900', embedIndex: 0,
  source: 'system-catalog', title: 'Example',
  snapshot: { title: 'Example', description: 'Body',
    author: { name: `Cloudy template key: ${key} || Cloudy context: ${context} || Cloudy kind: embed` } },
  ...extra,
});
const retired = { known: true, retired: true, upstreamOriginal: true, approved: false };
const upstream = { known: true, retired: false, upstreamOriginal: true, approved: false };
const approved = { known: true, retired: false, upstreamOriginal: true, approved: true };
const cloudyCode = { known: true, retired: false, upstreamOriginal: false, approved: false };

test('an unchanged retired fishing/fight template is archived; the same item with own changes stays', () => {
  const fishing = catalog('embed-type:fish', 'gambling/fish');
  assert.equal(classifyBuilderRecord(fishing, { source: retired }).decision, 'archive');
  assert.deepEqual(classifyBuilderRecord(fishing, { source: retired }).reasons, ['retired-command']);
  // Own text, or only a colour/logo/footer/picture/button change: a saved Builder change for this family.
  assert.equal(classifyBuilderRecord(fishing, { source: retired, savedOverlay: true }).decision, 'show');
  assert.equal(classifyBuilderRecord({ ...fishing, explicitSave: true }, { source: retired }).decision, 'show');
  assert.equal(classifyBuilderRecord(fishing, { source: retired, ownerFlags: { explicitSave: true } }).decision, 'show');
});

test('an old manualSaved flag alone is review: kept visible, never thrown away, hidden while state is unknown', () => {
  const legacy = catalog('embed-type:todo', 'botlog/todo', { manualSaved: true });
  const result = classifyBuilderRecord(legacy, { source: upstream });
  assert.equal(result.decision, 'review');
  assert.equal(result.ownerModified, null);
  assert.ok(result.reasons.includes('unproven-old-save'));
  assert.equal(isBuilderDecisionVisible(result, { reliable: true }), true, 'possible own work stays listed');
  assert.equal(isBuilderDecisionVisible(result, { reliable: false }), false, 'cold start: only proven items');
  // When the code already lists the family, the flag changes nothing.
  assert.equal(classifyBuilderRecord(legacy, { source: cloudyCode }).decision, 'show');
});

test('unchanged upstream examples are archived unless their feature is approved; Cloudy code is shown', () => {
  const record = catalog('embed-type:x', 'botlog/x');
  assert.equal(classifyBuilderRecord(record, { source: upstream }).decision, 'archive');
  assert.deepEqual(classifyBuilderRecord(record, { source: upstream }).reasons, ['unchanged-upstream-example']);
  assert.equal(classifyBuilderRecord(record, { source: approved }).decision, 'show');
  assert.equal(classifyBuilderRecord(record, { source: cloudyCode }).decision, 'show');
  assert.equal(classifyBuilderRecord(record, { fixedTemplate: true }).decision, 'show');
});

test('a family whose code is gone keeps its recorded decision; without one it is review (not shown)', () => {
  const record = catalog('embed-type:gone', 'botlog/gone');
  assert.equal(classifyBuilderRecord(record, { durableDecision: 'archive' }).decision, 'archive');
  assert.equal(classifyBuilderRecord(record, { durableDecision: 'show' }).decision, 'show');
  const unknown = classifyBuilderRecord(record, {});
  assert.equal(unknown.decision, 'review');
  assert.deepEqual(unknown.reasons, ['unknown-origin']);
  assert.equal(isBuilderDecisionVisible(unknown, { reliable: true }), false, 'not proven own: not listed');
  // The code's decision wins over an older recorded one (a deliberate code change).
  assert.equal(classifyBuilderRecord(record, { source: cloudyCode, durableDecision: 'archive' }).decision, 'show');
});

test('an ambiguous saved change (shared title) is review, a missing one is no evidence', () => {
  const record = catalog('embed-type:x', 'botlog/x');
  assert.equal(ownerEvidence(record, { savedOverlay: null }), null);
  assert.equal(classifyBuilderRecord(record, { source: upstream, savedOverlay: null }).decision, 'review');
  assert.equal(ownerEvidence(record, { savedOverlay: false }), false);
});

test('real messages, Builder posts and drafts are always listed and keep their physical identity', () => {
  const post = { guildId: 'g', channelId: 'c', messageId: '1', embedIndex: 0, source: 'embed-builder', manualSaved: true, snapshot: { title: 'Pop' } };
  const log = { guildId: 'g', channelId: 'logs', messageId: '2', embedIndex: 0, source: 'cloudy', snapshot: { title: 'Kick log' } };
  const draft = { guildId: 'g', channelId: 'c', messageId: 'draft-1', embedIndex: 0, source: 'embed-builder', detached: true, draftData: {}, snapshot: { title: 'Draft' } };
  for (const record of [post, log, draft]) {
    const result = classifyBuilderRecord(record, { source: retired });
    assert.equal(result.decision, 'show');
    assert.match(result.identity, /^physical:/);
  }
  // Two own posts with the same title are two identities.
  const twin = { ...post, messageId: '3' };
  assert.notEqual(classifyBuilderRecord(post).identity, classifyBuilderRecord(twin).identity);
});

test('a catalog family identity is guild + context + key, never the title', () => {
  const a = catalog('embed-type:a', 'botlog/a');
  const b = { ...catalog('embed-type:b', 'botlog/b'), snapshot: { ...a.snapshot,
    author: { name: 'Cloudy template key: embed-type:b || Cloudy context: botlog/b || Cloudy kind: embed' } } };
  assert.equal(a.snapshot.title, b.snapshot.title);
  assert.notEqual(classifyBuilderRecord(a).identity, classifyBuilderRecord(b).identity);
  assert.deepEqual(templateMetadata(a.snapshot), { key: 'embed-type:a', context: 'botlog/a', kind: 'embed' });
});

test('the text fingerprint ignores branding but sees every reworded word', () => {
  const base = { kind: 'embed', title: '✅ Success', description: 'Your **todo** was saved, ${user}!', color: 1, footer: { text: 'x' } };
  assert.equal(templateTextSignature(base), templateTextSignature({ ...base, title: 'success', color: 2, footer: { text: 'Cloudy' } }));
  assert.equal(templateTextSignature(base), templateTextSignature({ ...base, description: 'Your todo was saved, {dynamic}.' }));
  assert.notEqual(templateTextSignature(base), templateTextSignature({ ...base, description: 'Your task was saved.' }));
  assert.equal(templateTextSignature({ kind: 'embed', title: '{dynamic}' }), '');
});

test('the manifest knows the 12 retired files, their 19 families and the original TitanBot texts', () => {
  assert.equal(RETIRED_SOURCE_FILES.size, 12);
  assert.ok(isRetiredSourcePath('src/commands/Fun/count.js'));
  assert.ok(!isRetiredSourcePath('src/commands/Economy/gambling.js'), 'the current /gamble stays');
  assert.ok(RETIRED_TEMPLATE_FAMILIES.size >= 19);
  assert.ok(UPSTREAM_TEMPLATE_SIGNATURES.size > 400);
  assert.ok(isApprovedUpstreamSourcePath('commands/Economy/rob.js'));
  assert.ok(!isApprovedUpstreamSourcePath('commands/Utility/todo.js'));
  assert.ok(!isApprovedUpstreamSourcePath('commands/Welcome/modules/greet_dashboard.js'));
  assert.ok(isApprovedFeatureContext('gambling/rob'));
  assert.ok(!isApprovedFeatureContext('botlog/todo'));
});
