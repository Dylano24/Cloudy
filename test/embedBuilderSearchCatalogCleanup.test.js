import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function guildWith(...channels) {
  return {
    channels: {
      cache: new Map(channels.map(name => [
        name,
        { id: name, name, parent: null },
      ])),
    },
  };
}

function record({
  id,
  source = 'cloudy',
  channelId = 'botlog',
  title = 'Task Removed',
  description = 'Task removed from #botlog.',
  author = null,
}) {
  return {
    guildId: 'guild',
    channelId,
    messageId: id,
    embedIndex: 0,
    source,
    title,
    name: title,
    snapshot: {
      title,
      description,
      ...(author ? { author: { name: author } } : {}),
    },
    createdAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T08:00:00.000Z',
  };
}

test('Search collapses automated peers that differ only by technical catalog metadata', () => {
  const guild = guildWith('botlog');
  const records = [
    record({ id: '1', source: 'cloudy' }),
    record({
      id: '2',
      source: 'system-catalog',
      author: 'Cloudy template key: embed-type:abc123 || Cloudy context: botlog || Cloudy kind: embed',
    }),
    record({ id: '3', source: 'modified' }),
  ];

  const matches = buildMatches(guild, records, 'task removed');
  assert.equal(matches.length, 1);
});

test('Search keeps different bot messages but gives them unique descriptive names', () => {
  const guild = guildWith('botlog');
  const matches = buildMatches(guild, [
    record({ id: '10', description: 'Scheduled task removed from #botlog.' }),
    record({ id: '11', description: 'Verification task removed from #botlog.' }),
    record({ id: '12', description: 'Role reward task removed from #botlog.' }),
  ], 'task removed');

  assert.equal(matches.length, 3);

  const choices = buildSearchChoices(matches);
  const names = choices.map(choice => choice.name);
  assert.equal(new Set(names).size, 3);
  assert.ok(names.every(name => name.startsWith('Task Removed')));
  assert.ok(names.some(name => /Scheduled task/i.test(name)));
  assert.ok(names.some(name => /Verification task/i.test(name)));
  assert.ok(names.some(name => /Role reward task/i.test(name)));
});

test('Search never emits duplicate choice names even for two distinct identical manual embeds', () => {
  const guild = guildWith('general');
  const matches = buildMatches(guild, [
    record({
      id: '123456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
    record({
      id: '223456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
  ], 'custom panel');

  assert.equal(matches.length, 2);
  const choices = buildSearchChoices(matches);
  assert.equal(new Set(choices.map(choice => choice.name)).size, 2);
});

test('Search keeps useful system/error templates and hides history mirrors', () => {
  const guild = guildWith('gambling', 'botlog');
  const matches = buildMatches(guild, [
    record({
      id: 'catalog-invalid',
      source: 'system-catalog',
      channelId: 'gambling',
      title: 'Invalid Input',
      description: 'Please check your input and try again.',
      author: 'Cloudy template key: invalid input || Cloudy context: gambling || Cloudy kind: embed',
    }),
    record({
      id: 'history-invalid',
      source: 'bot-history',
      channelId: 'gambling',
      title: 'Invalid Input',
      description: 'Please check your input and try again.',
    }),
  ], 'invalid');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Invalid Input');
});


test('Search collapses runtime copies that differ only by dynamic IDs or task keys', () => {
  const guild = guildWith('botlog');
  const matches = buildMatches(guild, [
    record({
      id: '101',
      description: 'Task daily-reward was removed by <@111111111111111111>.',
    }),
    record({
      id: '102',
      description: 'Task cleanup-cache was removed by <@222222222222222222>.',
    }),
    record({
      id: '103',
      description: 'Task backup-logs was removed by <@333333333333333333>.',
    }),
  ], 'task removed');

  assert.equal(matches.length, 1);
});

test('Search uses readable Variant labels instead of raw message IDs when names still collide', () => {
  const guild = guildWith('general');
  const matches = buildMatches(guild, [
    record({
      id: '123456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
    record({
      id: '223456789012345678',
      source: 'embed-builder',
      channelId: 'general',
      title: 'Custom panel',
      description: 'Same manual content.',
    }),
  ], 'custom panel');

  const names = buildSearchChoices(matches).map(choice => choice.name);
  assert.ok(names.some(name => /Variant 2$/i.test(name)));
  assert.ok(names.every(name => !/345678/.test(name)));
});
