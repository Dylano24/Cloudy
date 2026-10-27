import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndexedAutocompleteMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guildId = '1900000000000000001';
const channelId = '1900000000000000002';
const member = { id: '1900000000000000003' };
const guild = {
  id: guildId,
  channels: { cache: new Map([[channelId, {
    id: channelId, name: 'cloudy-logs', permissionsFor: () => ({ has: () => true }),
  }]]) },
};
function record(title, i) {
  return {
    guildId, channelId, messageId: String(1900000000000010000n + BigInt(i)),
    source: 'embed-builder', manualSaved: true, embedIndex: 0,
    title, name: title, snapshot: { title, description: 'A Cloudy response with a saved description.' },
  };
}

test('every letter A–Z returns autocomplete choices, including single letters inside words', () => {
  // 3,900 records: long descriptions and shared terms previously forced the
  // slow canonical path on broad letters while the candidate index matched.
  const records = [];
  for (let i = 0; i < 3900; i++) {
    const title = 'Saved Cloudy record ' + String(i);
    records.push(record(title, i));
  }
  // Ensure a distinct selectable title for EVERY starting letter, including
  // those that appear only in the middle of an ordinary word.
  for (let i = 0; i < 26; i++) {
    records.push(record(String.fromCharCode(65 + i) + ' unique saved embed', 3900 + i));
  }
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const matches = buildIndexedAutocompleteMatches(guild, member, records, letter);
    const choices = buildSearchChoices(matches);
    assert.ok(choices.length > 0, letter + ' should never get stuck on an empty list');
    assert.ok(choices.length <= 25, letter + ' cannot exceed Discord choice limit');
    assert.ok(choices.every(choice => typeof choice.name === 'string' && choice.name.length <= 100
      && choice.value.length <= 100), 'all choices must be Discord-compatible');
  }
});

test('single letter inside a saved title is searchable even without a word starting with it', () => {
  const records = [record('Echo', 9993), record('Cliff', 9994)];
  const choices = buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, records, 'h'));
  assert.ok(choices.some(choice => choice.name === 'Echo'));
  const second = buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, records, 'l'));
  assert.ok(second.some(choice => choice.name === 'Cliff'));
});

test('broad queries still offer 25 unique ranked choices with hidden and duplicate titles', () => {
  const records = Array.from({ length: 300 }, (_, i) =>
    record(i < 50 ? 'Shared test' : 'Test result ' + String(i), 10000 + i));
  const choices = buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, records, 't'));
  assert.equal(choices.length, 25);
  assert.equal(new Set(choices.map(choice => choice.name)).size, 25);
});
