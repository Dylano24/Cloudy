import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexedAutocompleteMatches,
  buildSearchChoices,
  invalidateBuilderSearchTitleCache,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guildId = '1844444444444444441';
const channelId = '1844444444444444442';
const guild = { id: guildId, channels: { cache: new Map([[channelId, {
  id: channelId, name: 'botlog', permissionsFor: () => ({ has: () => true }),
}]]) } };
const member = { id: '1844444444444444443' };
function record(index, title, desc = 'The quick brown fox jumps over the lazy dog') {
  return {
    guildId, channelId, messageId: String(1844444444444400000n + BigInt(index)),
    source: 'embed-builder', manualSaved: true, name: title,
    snapshot: { title, description: desc }, embedIndex: 0,
  };
}
const names = (records, query) => buildSearchChoices(
  buildIndexedAutocompleteMatches(guild, member, records, query),
).map(x => x.name);

test('cached candidate metadata stays fresh with new registry generations and owner Save', () => {
  const a = [record(1, 'Initial title'), record(2, 'Other')];
  assert.deepEqual(names(a, 'initial'), ['Initial title']);
  const otherGeneration = structuredClone(a);
  otherGeneration.push(record(3, 'New response'));
  assert.deepEqual(names(otherGeneration, 'new'), ['New response']);
  assert.deepEqual(names(otherGeneration, 'initial'), ['Initial title']);
  const changed = structuredClone(otherGeneration);
  changed[0].name = 'Saved changed title';
  changed[0].snapshot.title = 'Saved changed title';
  invalidateBuilderSearchTitleCache(guildId);
  assert.deepEqual(names(changed, 'saved changed'), ['Saved changed title']);
  assert.deepEqual(names(changed, 'initial'), []);
});

test('generation changes do not allow deleted or permission-denied records to reappear', () => {
  const inaccessible = '1844444444444444444';
  guild.channels.cache.set(inaccessible, {
    id: inaccessible, permissionsFor: () => ({ has: () => false }),
  });
  const a = [record(8, 'Find me'), { ...record(9, 'Private result'), channelId: inaccessible }];
  assert.deepEqual(names(a, 'find'), ['Find me']);
  const b = structuredClone(a);
  b.splice(0, 1);
  assert.deepEqual(names(b, 'find'), []);
  assert.deepEqual(names(b, 'private'), []);
  guild.channels.cache.delete(inaccessible);
});

test('4,000-record index retains A-Z, stable ranking and original results after fresh clones', () => {
  const originals = Array.from({ length: 4000 }, (_, i) =>
    record(100 + i, 'Cloudy log ' + String(i)));
  const queries = ['a', 'p', 'g', 'q', 'z', 'cloudy', 'log 72', 'fox'];
  const prior = queries.map(query => names(originals, query));
  for (let i = 0; i < 3; i++) {
    const clone = structuredClone(originals);
    for (let j = 0; j < queries.length; j++) {
      assert.deepEqual(names(clone, queries[j]), prior[j], queries[j]);
    }
  }
});
