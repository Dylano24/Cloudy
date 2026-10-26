import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  buildIndexedAutocompleteMatches,
  buildAutocompleteMatches,
  buildSearchChoices,
  beginBuilderSearchDeletion,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('indexed Search keeps saved titles, permissions, and Delete filtering with 4,000 log records', () => {
  const guildId = '1900000000000000001';
  const visible = '1900000000000000002';
  const privateId = '1900000000000000003';
  const allowedChannel = { id: visible, name: 'botlog',
    permissionsFor: () => ({ has: () => true }) };
  const deniedChannel = { id: privateId, name: 'private',
    permissionsFor: () => ({ has: permission => ![PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages].flat()
      .includes(permission) }) };
  const guild = { id: guildId, channels: { cache: new Map([
    [visible, allowedChannel], [privateId, deniedChannel],
  ]) } };
  const member = { id: '1900000000000000004' };
  const base = (i, channelId = visible) => ({
    guildId, channelId, messageId: String(1900000000000010000n + BigInt(i)),
    embedIndex: 0, source: 'embed-builder', manualSaved: true,
    snapshot: { title: 'Unique Cloudy log ' + i, description: 'Testing Search body ' + i },
    name: 'Unique Cloudy log ' + i,
  });
  const records = Array.from({ length: 4000 }, (_, i) => base(i));
  records.push({ ...base(4100), channelId: privateId,
    snapshot: { title: 'Hidden classified embed', description: 'Private data' }, name: 'Hidden classified embed' });
  const matches = buildIndexedAutocompleteMatches(guild, member, records, 'Unique Cloudy log 302');
  assert.ok(matches.length);
  assert.ok(matches.some(x => x.record.snapshot.title === 'Unique Cloudy log 302'));
  assert.ok(!buildIndexedAutocompleteMatches(guild, member, records, 'Hidden classified')
    .some(x => x.record.channelId === privateId));

  const finish = beginBuilderSearchDeletion(guildId, records[302]);
  try {
    const hidden = buildIndexedAutocompleteMatches(guild, member, records, 'Unique Cloudy log 302');
    assert.ok(hidden.every(x => x.record.messageId !== records[302].messageId),
      'a cached index must still honor the instantaneous Delete tombstone');
  } finally {
    finish(false);
  }

  assert.ok(buildSearchChoices(buildAutocompleteMatches(guild, records.slice(299, 305), '302'))
    .some(x => /302/.test(x.name)));
  assert.ok(buildIndexedAutocompleteMatches(guild, member, records, 'Unique Cloudy log 302')
    .some(x => x.record.messageId === records[302].messageId),
    'failed Delete restores Search even with a warm index');
});
