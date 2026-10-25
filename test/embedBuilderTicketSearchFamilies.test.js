import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMatches, buildAutocompleteMatches, buildSearchChoices, recordTitle,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guildId = 'ticket-search-families-2026-10-25';
const channelId = '111111111111111177';
const guild = {
  id: guildId,
  channels: { cache: new Map([[channelId, { id: channelId, name: 'ticket-logs' }]]) },
};
function log(index, action = 'closed') {
  const title = `Ticket ${action}: Case${index}`;
  return {
    guildId, channelId, messageId: String(111111111111111000n + BigInt(index)),
    embedIndex: 0, source: 'bot-history', manualSaved: false,
    title, name: title, createdAt: new Date(Date.UTC(2026, 9, 25, 16, index % 60)).toISOString(),
    snapshot: {
      title,
      description: `Ticket ${index} archived by staff.`,
      fields: [
        { name: 'Ticket', value: String(index), inline: false },
        { name: action === 'closed' ? 'Closed by' : 'Deleted by', value: '<@123456789012345678>', inline: true },
      ],
    },
  };
}

test('many physical closed ticket logs become exactly one Search template, without modifying any log', () => {
  const originals = Array.from({ length: 7 }, (_, i) => log(i + 1));
  const snapshots = structuredClone(originals);
  const matches = buildMatches(guild, originals, 'ticket');
  assert.equal(matches.length, 1);
  assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), ['Ticket closed']);
  assert.deepEqual(originals, snapshots, 'physical logs and their names remain untouched');
});

test('different ticket events stay separate while many instances of each event do not', () => {
  const originals = [...Array.from({ length: 6 }, (_, i) => log(i + 20)),
    ...Array.from({ length: 4 }, (_, i) => log(i + 40, 'deleted'))];
  const names = buildSearchChoices(buildMatches(guild, originals, 'ticket')).map(choice => choice.name).sort();
  assert.deepEqual(names, ['Ticket closed', 'Ticket deleted']);
});

test('autocomplete with over 80 ticket instances still includes both response families', () => {
  const originals = [...Array.from({ length: 98 }, (_, i) => log(i + 100)),
    log(301, 'deleted'), log(302, 'deleted')];
  const options = buildSearchChoices(buildAutocompleteMatches(guild, originals, 'ticket'));
  assert.deepEqual(options.map(o => o.name).sort(), ['Ticket closed', 'Ticket deleted']);
});

test('manual Builder Saves retain their exact specific ticket title', () => {
  const individual = log(404);
  individual.source = 'embed-builder';
  individual.manualSaved = true;
  individual.snapshot.title = 'Ticket closed: Custom owner label';
  individual.title = individual.snapshot.title;
  individual.name = individual.title;
  assert.equal(recordTitle(individual), individual.title);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [individual], 'Custom owner label'))
    .map(o => o.name), ['Ticket closed: Custom owner label']);
});
