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

test('custom emoji artwork stays saved while Search shows an emoji, never an internal name', () => {
  const raw = 'Removed from builder <:cloudyCustom:123456789012345678>';
  const choice = buildSearchChoices([
    option('123456789012345681', raw, 'An owner-edited body that must remain in the full preview.'),
  ]);
  assert.equal(choice[0].name, 'Removed from builder ☁️');
  assert.equal(humanSearchChoiceTitle('Welcome <:verified:123456789012345678>'), 'Welcome ✅');
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


test('Rust custom emoji and iOS colon fallback show a real Unicode emoji instead of :X89rust10:', () => {
  const real = 'Removed from builder <a:X89rust10:123456789012345678>';
  const optionRecord = option('123456789012345699', real, 'Original full embed text must stay in preview.');
  const [choice] = buildSearchChoices([optionRecord]);
  assert.equal(choice.name, 'Removed from builder 🎮');
  assert.equal(humanSearchChoiceTitle('Removed from builder :X89rust10:'), 'Removed from builder 🎮');
  assert.ok(!choice.name.includes('X89rust10'));
  assert.equal(optionRecord.record.snapshot.title, real, 'no mutation of saved custom emoji');
  assert.equal(optionRecord.record.snapshot.description, 'Original full embed text must stay in preview.');
});

test('unknown custom emojis never expose IDs, names or preview contents in Search', () => {
  const raw = 'Welcome <a:unrecognized_artwork:123456789012345678>';
  const choice = buildSearchChoices([option('123456789012345698', raw, 'Private report and ticket details.')]);
  assert.deepEqual(choice.map(c => c.name), ['Welcome 🔹']);
  assert.ok(!choice[0].name.includes('unrecognized'));
  assert.ok(!choice[0].name.includes('123456789'));
  assert.ok(!choice[0].name.includes('Private report'));
});
