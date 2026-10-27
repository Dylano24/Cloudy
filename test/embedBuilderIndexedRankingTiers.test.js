import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexedAutocompleteMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guildId = '1922222222222222222';
const channelId = '1933333333333333333';
const guild = {
  id: guildId,
  channels: { cache: new Map([[channelId, {
    id: channelId, name: 'logs',
    permissionsFor: () => ({ has: () => true }),
  }]]) },
};
const member = { id: '1944444444444444444' };

function record(id, title, description = 'Text') {
  return {
    guildId, channelId, messageId: String(1955555555555555555n + BigInt(id)),
    source: 'embed-builder', manualSaved: true, embedIndex: 0,
    name: title, title, snapshot: { title, description },
  };
}

test('ranked index preserves exact, prefix, substring, body and multiword search', () => {
  const records = [
    record(1, 'Search', 'Common'),
    record(2, 'Search tips', 'Common'),
    record(3, 'Research', 'Common'),
    record(4, 'Inbox', 'Search in details'),
    record(5, 'Example', 'Another Search topic'),
    record(6, 'Other name', 'Search again'),
    record(7, 'Search and save', 'Common'),
  ];
  const names = query => buildSearchChoices(
    buildIndexedAutocompleteMatches(guild, member, records, query),
  ).map(x => x.name);
  assert.deepEqual(names('search'), [
    'Search', 'Search and save', 'Search tips', 'Research',
    'Example', 'Inbox', 'Other name',
  ]);
  assert.ok(names('search in').includes('Inbox'));
  assert.ok(names('res').includes('Research'));
});

test('large index keeps all 25 unique choices and reuses index safely on every letter', () => {
  const records = Array.from({ length: 4000 }, (_, index) =>
    record(index, 'Cloudy result ' + index, 'The quick brown fox jumps over the lazy dog'));
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const choices = buildSearchChoices(buildIndexedAutocompleteMatches(
      guild, member, records, letter,
    ));
    assert.equal(choices.length, 25, 'letter ' + letter);
    assert.equal(new Set(choices.map(x => x.name)).size, 25);
  }
});

test('a new saved snapshot array is never shadowed by previously cached titles', () => {
  const first = [record(23, 'First saved name', 'Body')];
  const second = [record(23, 'Updated saved name', 'Body')];
  const before = buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, first, 'first'));
  assert.equal(before[0].name, 'First saved name');
  const after = buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, second, 'updated'));
  assert.equal(after[0].name, 'Updated saved name');
  assert.equal(buildSearchChoices(buildIndexedAutocompleteMatches(guild, member, second, 'first')).length, 0);
});
