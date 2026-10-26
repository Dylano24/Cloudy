import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchChoices, humanSearchChoiceTitle,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function option(messageId, title, description, extra = {}) {
  return {
    record: {
      guildId: 'title-only-search', channelId: '123456789012345678',
      messageId, embedIndex: 0, source: 'embed-builder',
      manualSaved: true, snapshot: { title, description },
      ...extra,
    },
    document: { title, channel: { name: 'ticket-logs' } },
    score: 10000,
  };
}

test('autocomplete shows ONLY the saved title, never body, fields, channel or context', () => {
  const title = 'Removed from builder ✅';
  const choices = buildSearchChoices([
    option('123456789012345679', title, 'Sensitive ticket ID and staff names'),
    option('123456789012345680', title, 'Other private ticket body'),
  ]);
  assert.deepEqual(choices.map(x => x.name), [title]);
  assert.equal(choices.length, 1);
  assert.ok(choices.every(x => !/Sensitive|Other private|ticket-logs|Variant/i.test(x.name)));
});

test('native Search keeps the exact saved custom emoji code in the title', () => {
  const raw = 'Removed from builder <:cloudyCustom:123456789012345678>';
  const choice = buildSearchChoices([
    option('123456789012345681', raw, 'An owner-edited body that must remain in the full preview.'),
  ]);
  assert.equal(choice[0].name, raw);
  assert.equal(humanSearchChoiceTitle('Welcome <:verified:123456789012345678>'), 'Welcome <:verified:123456789012345678>');
  assert.equal(raw, 'Removed from builder <:cloudyCustom:123456789012345678>');
});

test('same name gives owner-saved version priority, without displaying details', () => {
  const original = option('123456789012345682', 'Cloudy notice', 'Old catalog description', {
    source: 'system-catalog', manualSaved: false,
  });
  const changed = option('123456789012345683', 'Cloudy notice', 'Owner saved description', {
    source: 'embed-builder', manualSaved: true,
  });
  const choices = buildSearchChoices([original, changed]);
  assert.deepEqual(choices, [{ name: 'Cloudy notice', value: '123456789012345678:123456789012345683:0' }]);
  assert.equal(changed.record.snapshot.description, 'Owner saved description');
});

test('Rust-style custom emoji codes and iOS shortcodes remain literal in Search titles', () => {
  const original = 'Removed from builder <a:X89rust10:123456789012345678>';
  const choices = buildSearchChoices([option('123456789012345684', original, 'Private description only')]);
  assert.equal(choices[0].name, original);
  assert.equal(humanSearchChoiceTitle('Removed from builder :X89rust10:'), 'Removed from builder :X89rust10:');
  assert.equal(choices[0].name.includes('Private description'), false);
  assert.equal(original, 'Removed from builder <a:X89rust10:123456789012345678>',
    'the real saved Discord emoji is preserved for the embed preview');
});

test('unknown custom emoji codes are preserved without inventing replacement symbols', () => {
  const title = 'Custom brand <:unknownUniqueLogo:123456789012345678>';
  const native = humanSearchChoiceTitle(title);
  assert.equal(native, title);
  assert.equal(native.includes('unknownUniqueLogo'), true);
  assert.equal(title.includes('unknownUniqueLogo'), true);
});
