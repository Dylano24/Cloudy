import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
  latestRealPreviewRecord,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guild = { id: 'report-family', channels: { cache: new Map() } };

function report(number, reason, { source = 'cloudy', evidence = true } = {}) {
  return {
    guildId: guild.id,
    channelId: 'report-logs',
    messageId: String(number),
    embedIndex: 0,
    source,
    createdAt: `2026-10-24T08:00:${number}Z`,
    snapshot: {
      title: `New report #${number}`,
      fields: [
        { name: 'Reported member', value: '<@111111111111111111>' },
        { name: 'Reported by', value: '<@222222222222222222>' },
        { name: 'Reason', value: reason },
        ...(evidence ? [{ name: 'Evidence', value: `Message content ${number}` }] : []),
      ],
      footer: { text: 'Cloudy' },
    },
    components: [{ type: 1, components: [{
      type: 2, style: 2, label: 'Read', custom_id: `report_case:read:${number}:staff`,
    }] }],
  };
}

test('Search exposes one New report template across report numbers, reasons and evidence shapes', () => {
  const records = [report(17, 'Insulting message'), report(18, 'Spam', { evidence: false }), report(19, 'Hjnkm')];
  const before = structuredClone(records);

  for (const query of ['report', 'new report']) {
    const matches = buildMatches(guild, records, query);
    assert.equal(matches.length, 1);
    assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), ['New report']);
    assert.equal(matches[0].record.messageId, '19');
    assert.deepEqual(matches[0].record.components, records[2].components);
    assert.deepEqual(matches[0].record.snapshot, records[2].snapshot);
  }
  assert.deepEqual(records, before, 'Search must not alter the real report history');
});

test('legacy catalog captures and a canonical report preview share the same Search family', () => {
  const records = [report(17, 'Insult', { source: 'system-catalog' }), report(18, 'Spam', { source: 'system-catalog' })];
  records.forEach((record, index) => {
    record.snapshot.author = { name: `Cloudy template key: embed:legacy-${index} || Cloudy context: reports/report` };
  });
  const live = report(19, 'Latest reason', { source: 'bot-history' });
  live.canonicalIdentity = 'new report #{dynamic}';
  records.push(live);

  const matches = buildMatches(guild, records, 'new report');
  assert.equal(matches.length, 1);
  assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), ['New report']);
  assert.equal(matches[0].record.messageId, '19');
  assert.equal(latestRealPreviewRecord(guild, records, records[0]).messageId, '19');
});

test('manual New report embeds and other report response types remain distinct', () => {
  const records = [
    report(17, 'Insult'), report(18, 'Spam'),
    report(20, 'Manual form A', { source: 'embed-builder' }),
    report(21, 'Manual form B', { source: 'embed-builder' }),
    { ...report(22, 'Saved custom form'), manualSaved: true },
    ...['Report submitted', 'Report notification', 'Report deleted'].map((title, index) => ({
      ...report(23 + index, 'Other response'), snapshot: { title, description: 'Other response' },
    })),
  ];
  const matches = buildMatches(guild, records, 'report');
  assert.equal(matches.length, 6);
  assert.equal(matches.filter(match => match.record.source !== 'embed-builder'
    && match.document.title === 'New report').length, 1);
  for (const id of ['20', '21', '22', '23', '24', '25']) {
    assert.ok(matches.some(match => match.record.messageId === id), `missing independent response ${id}`);
  }
});
