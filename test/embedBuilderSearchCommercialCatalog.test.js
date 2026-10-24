import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import {
  buildMatches,
  buildSearchChoices,
  buildAutocompleteMatches,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function guildWithChannel(id = 'botlog', name = 'botlog') {
  return {
    channels: {
      cache: new Map([[id, { id, name, parent: null }]]),
    },
  };
}

function automated({
  id,
  title = 'Task Removed',
  description = 'Task 123 was removed.',
  channelId = 'botlog',
  source = 'cloudy',
  footer = '© Cloudy Inc. • Quality. Innovation. Performance.',
  thumbnail = null,
}) {
  return {
    guildId: 'guild',
    channelId,
    messageId: id,
    embedIndex: 0,
    source,
    title,
    name: title,
    createdAt: '2026-10-06T10:00:00.000Z',
    snapshot: {
      title,
      description,
      footer: { text: footer },
      ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}),
    },
  };
}

test('Search collapses semantic automated duplicates even when visual decoration differs', () => {
  const guild = guildWithChannel();
  const matches = buildMatches(guild, [
    automated({ id: '1', description: 'Task 123 was removed.', thumbnail: 'https://cdn.example.com/a.png' }),
    automated({ id: '2', description: 'Task 456 was removed.', thumbnail: 'https://cdn.example.com/b.png', footer: 'Cloudy' }),
  ], 'task removed');

  assert.equal(matches.length, 1);
});

test('Search hides Builder/internal UI records even if they leak into a source list', () => {
  const guild = guildWithChannel('general', 'general');
  const matches = buildMatches(guild, [
    automated({ id: '1', channelId: 'general', title: 'Message builder', description: 'Use the buttons below.' }),
    automated({ id: '2', channelId: 'general', title: 'Changes saved', description: 'Saved.' }),
    automated({ id: '3', channelId: 'general', title: 'Invalid code', description: 'That code is invalid.' }),
  ], '');

  assert.deepEqual(matches.map(match => match.document.title), ['Invalid code']);
});

test('Search keeps different same-title responses and gives them distinct readable names', () => {
  const guild = guildWithChannel();
  const matches = buildMatches(guild, [
    automated({ id: '1', description: 'Scheduled task was removed.' }),
    automated({ id: '2', description: 'Verification task was removed.' }),
  ], 'task removed');

  assert.equal(matches.length, 2);

  const choices = buildSearchChoices(matches);
  assert.equal(new Set(choices.map(choice => choice.name)).size, 2);
  assert.ok(choices.every(choice => !/Variant \d+/i.test(choice.name)));
  assert.ok(choices.some(choice => /Scheduled task/i.test(choice.name)));
  assert.ok(choices.some(choice => /Verification task/i.test(choice.name)));
});

test('Search collapses identical manual Builder embeds into one clean result', () => {
  const guild = guildWithChannel('general', 'general');
  const records = [
    automated({ id: 'manual-1', channelId: 'general', title: 'Rules', description: 'Same', source: 'embed-builder' }),
    automated({ id: 'manual-2', channelId: 'general', title: 'Rules', description: 'Same', source: 'embed-builder' }),
  ];

  assert.equal(buildMatches(guild, records, 'rules').length, 1);
});


test('same automated response shown in different channels is still one Search result', () => {
  const guild = {
    channels: {
      cache: new Map([
        ['botlog', { id: 'botlog', name: 'botlog', parent: null }],
        ['general', { id: 'general', name: 'general', parent: null }],
      ]),
    },
  };

  const matches = buildMatches(guild, [
    automated({ id: '1', channelId: 'botlog', description: 'Task 123 was removed.' }),
    automated({ id: '2', channelId: 'general', description: 'Task 456 was removed.' }),
  ], 'task removed');

  assert.equal(matches.length, 1);
});

test('autocomplete searches a 4,000-entry catalog without fully hydrating every match', () => {
  const guild = guildWithChannel();
  const catalog = Array.from({ length: 4000 }, (_, i) => automated({
    id: String(i + 1),
    source: 'system-catalog',
    title: 'General notice ' + i,
    description: 'Generic response ' + i,
  }));
  catalog.push(automated({ id: '5000', title: 'Ping!', description: 'Bot latency: 88ms', source: 'system-catalog' }));
  catalog.push(automated({ id: '5001', title: 'Ping!', description: 'Bot latency: 99ms', source: 'system-catalog' }));
  const started = performance.now();
  const matches = buildAutocompleteMatches(guild, catalog, 'ping');
  const elapsed = performance.now() - started;
  assert.deepEqual(buildSearchChoices(matches).map(x => x.name), ['Ping!']);
  assert.ok(elapsed < 1800, `Autocomplete catalog filtering took ${elapsed}ms`);
});

test('autocomplete finds a response whose title is generic but body names the requested action', () => {
  const guild = guildWithChannel();
  const catalog = Array.from({ length: 100 }, (_, i) => automated({
    id: String(1000 + i), source: 'system-catalog', title: 'Unrelated notice ' + i,
    description: 'Other unrelated response',
  }));
  catalog.push(automated({ id: '9999', title: 'Error', description: 'Appeal action service denied this request.', source: 'system-catalog' }));
  const result = buildAutocompleteMatches(guild, catalog, 'appeal action');
  assert.ok(result.some(x => x.record.messageId === '9999'));
});

test('autocomplete preserves a manually saved embed but excludes a non-saved draft', () => {
  const guild = guildWithChannel();
  const records = Array.from({ length: 100 }, (_, i) => automated({
    id: String(i + 100), source: 'system-catalog', title: 'Filler ' + i,
  }));
  records.push({ ...automated({ id: 'saved', title: 'Builder policy', source: 'embed-builder' }), manualSaved: true });
  records.push({ ...automated({ id: 'unsaved', title: 'Builder policy', source: 'embed-builder' }), manualSaved: false });
  const matches = buildAutocompleteMatches(guild, records, 'builder policy');
  assert.ok(matches.some(x => x.record.messageId === 'saved'));
  assert.ok(!matches.some(x => x.record.messageId === 'unsaved'));
});
