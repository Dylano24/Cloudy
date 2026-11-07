import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../src/services/builderCatalogPolicy.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const base = {title: 'Old utility reply', description: 'First  line\n\nSecond line', color: 0xFFFFFF};
const catalog = (extra = {}) => ({guildId: 'g', channelId: 'c', messageId: 'm', embedIndex: 0,
  source: 'system-catalog', snapshot: {...base,
    author: {name: 'Cloudy template key: legacy:shorten || Cloudy context: utility/shorten || Cloudy kind: embed'}}, ...extra});
function classify(record, evidence = {}) {
  assert.equal(typeof api.classifyBuilderRecord, 'function', 'Missing shared Builder policy');
  return api.classifyBuilderRecord(record, evidence);
}

test('unchanged never-used optional source examples are archived despite an automatic save flag', () => {
  for (const extra of [{}, {manualSaved: true}]) {
    const result = classify(catalog(extra), {baseline: base, everUsed: false});
    assert.equal(result.decision, 'archive');
    assert.equal(result.ownerModified, false);
  }
});

test('verified historical use is preserved under the owner request to keep everything we use or used', () => {
  assert.equal(classify(catalog(), {baseline: base, everUsed: true}).decision, 'show');
});

test('unknown usage is preserved for review rather than treated as never used', () => {
  assert.equal(classify(catalog(), {baseline: base, usageState: 'unknown'}).decision, 'review');
});

test('plain-text catalog examples use the same policy as embeds', () => {
  const record = catalog();
  record.snapshot.author.name = 'Cloudy template key: legacy:shorten || Cloudy context: utility/shorten || Cloudy kind: content';
  assert.equal(classify(record, {baseline: base}).decision, 'archive');
});

test('explicit owner Saves and confirmed saved overlays survive retired functions', () => {
  assert.equal(classify(catalog({explicitSave: true}), {baseline: base}).decision, 'show');
  assert.equal(classify(catalog(), {baseline: base, ownerModified: true}).decision, 'show');
  assert.equal(classify(catalog({source: 'modified-template'}), {baseline: base}).decision, 'show');
});

test('a saved private draft remains available without needing a posted Discord message', () => {
  assert.equal(classify(catalog({source: 'embed-builder', detached: true, explicitSave: true, messageId: 'draft-123'})).decision, 'show');
});

test('each owner-visible change is preserved for review instead of being removed as old code', () => {
  const variants = [
    {title: 'My title'}, {description: 'First line\n\nSecond line'}, {color: 0x123456},
    {footer: {text: 'My footer'}}, {thumbnail: {url: 'https://example.test/my-logo.png'}},
    {image: {url: 'https://example.test/original.gif'}}, {fields: [{name: 'Prize', value: 'My value'}]},
    {author: {name: 'My author', url: 'https://example.test/my-link'}}, {url: 'https://example.test/my-link'},
    {author: {name: catalog().snapshot.author.name, icon_url: 'https://example.test/my-author.gif'}},
    {author: {name: catalog().snapshot.author.name, url: 'https://example.test/my-author-link'}},
  ];
  for (const delta of variants) {
    const record = catalog();
    record.snapshot = {...record.snapshot, ...delta};
    const before = structuredClone(record);
    assert.equal(classify(record, {baseline: base}).decision, 'review', JSON.stringify(delta));
    assert.deepEqual(record, before, 'classification never normalizes or rewrites the stored content');
  }
  assert.equal(classify(catalog({components: [{type: 1, components: [{type: 2, label: 'Mine', custom_id: 'my-button'}]}]}), {baseline: base}).decision, 'review');
});

test('a historical Builder source label without modern ownership evidence is kept for review', () => {
  assert.equal(classify(catalog({source: 'embed-builder', manualSaved: true})).decision, 'review');
});

test('unknown source and failed metadata loads never cause a destructive archive decision', () => {
  const record = catalog();
  record.snapshot.author.name = 'Cloudy template key: ancient || Cloudy context: unknown/old || Cloudy kind: embed';
  assert.equal(classify(record, {loadState: 'failed'}).decision, 'review');
  assert.equal(classify(record).decision, 'review');
});

test('approved current Cloudy families and fixed notifications remain available', () => {
  const record = catalog();
  record.snapshot.author.name = 'Cloudy template key: claim || Cloudy context: giveaway/claim || Cloudy kind: embed';
  assert.equal(classify(record).decision, 'show');
  assert.equal(classify(catalog(), {curated: true}).decision, 'show');
});

test('retired source paths remain recognizable independently of directory discovery', () => {
  assert.equal(classify(catalog(), {baseline: base, sourcePath: 'src/commands/Economy/fish.js'}).featureState, 'retired');
  assert.equal(classify(catalog(), {baseline: base, sourcePath: 'src/commands/Economy/fish.js'}).decision, 'archive');
});

test('different physical messages and different contexts have independent identities even with the same title', () => {
  assert.equal(typeof api.builderCatalogIdentity, 'function', 'Missing stable policy identity');
  assert.equal(api.builderCatalogIdentity(catalog()), 'catalog|g|embed|utility/shorten|legacy:shorten');
  assert.equal(api.builderCatalogIdentity(catalog({source: 'embed-builder', channelId: 'real', backingChannelId: 'physical'})), 'physical|g|physical|m|0');
  const other = catalog();
  other.snapshot.author.name = 'Cloudy template key: legacy:shorten || Cloudy context: utility/time || Cloudy kind: embed';
  assert.notEqual(api.builderCatalogIdentity(other), api.builderCatalogIdentity(catalog()));
});

test('a prior archive is honored only for the exact family, guild and unchanged snapshot', () => {
  assert.equal(typeof api.builderCatalogFingerprint, 'function', 'Missing preservation fingerprint');
  const record = catalog();
  const previous = {identity: 'catalog|g|embed|utility/shorten|legacy:shorten', decision: 'archive', fingerprint: api.builderCatalogFingerprint(record)};
  assert.equal(classify(record, {previous}).decision, 'archive');
  assert.equal(classify(catalog({guildId: 'other-guild'}), {previous}).decision, 'review');
  const changed = catalog();
  changed.snapshot.image = {url: 'https://example.test/mine.gif'};
  assert.equal(classify(changed, {previous}).decision, 'review');
  assert.equal(classify(catalog({explicitSave: true}), {previous}).decision, 'show');
});

test('a frozen source fingerprint recognizes a removed template after restart without storing old rendering code', () => {
  const record = catalog();
  const baselineFingerprint = api.builderCatalogFingerprint(record);
  assert.equal(classify(record, {baselineFingerprint}).decision, 'archive');
  record.snapshot.color = 0x123456;
  assert.equal(classify(record, {baselineFingerprint}).decision, 'review');
  assert.equal(classify(catalog({explicitSave: true}), {baselineFingerprint}).decision, 'show');
  for (const authorProperty of [{icon_url: 'https://example.test/my-author.gif'}, {url: 'https://example.test/my-author-link'}]) {
    const custom = catalog();
    Object.assign(custom.snapshot.author, authorProperty);
    assert.equal(classify(custom, {baselineFingerprint}).decision, 'review', JSON.stringify(authorProperty));
  }
});
