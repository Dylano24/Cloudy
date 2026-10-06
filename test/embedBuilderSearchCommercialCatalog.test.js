import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
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

test('Search never collapses manual Builder embeds just because title/content match', () => {
  const guild = guildWithChannel('general', 'general');
  const records = [
    automated({ id: 'manual-1', channelId: 'general', title: 'Rules', description: 'Same', source: 'embed-builder' }),
    automated({ id: 'manual-2', channelId: 'general', title: 'Rules', description: 'Same', source: 'embed-builder' }),
  ];

  assert.equal(buildMatches(guild, records, 'rules').length, 2);
});
