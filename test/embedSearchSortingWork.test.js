import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndexedAutocompleteMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('warm search reuses locale comparison setup while preserving alphabetic results', t => {
  const guildId = 'sorting-work', channelId = '1900000000000000002';
  const guild = { id: guildId, channels: { cache: new Map([[channelId, {
    id: channelId, permissionsFor: () => ({ has: () => true }),
  }]]) } };
  const records = ['Zebra', 'éclair', 'Alpha', 'Bravo'].map((title, i) => ({
    guildId, channelId, messageId: String(1900000000000000100n + BigInt(i)),
    source: 'embed-builder', manualSaved: true, snapshot: { title, description: 'Owner text' }, name: title,
  }));
  buildIndexedAutocompleteMatches(guild, { id: 'owner' }, records, '');
  let repeatedLocaleSetup = 0;
  const original = String.prototype.localeCompare;
  t.mock.method(String.prototype, 'localeCompare', function (other, locale, options) {
    if (options) repeatedLocaleSetup++;
    return original.call(this, other, locale, options);
  });
  const result = buildIndexedAutocompleteMatches(guild, { id: 'owner' }, records, '');
  assert.deepEqual(result.map(match => match.document.title), ['Alpha', 'Bravo', 'éclair', 'Zebra']);
  assert.equal(repeatedLocaleSetup, 0, 'reuse an Intl.Collator instead of setting up ICU for every comparison');
});
