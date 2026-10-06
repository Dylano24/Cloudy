import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function guild() {
  return {
    channels: {
      cache: new Map([
        ['botlog', { id: 'botlog', name: 'botlog', parent: null }],
        ['general', { id: 'general', name: 'general', parent: null }],
      ]),
    },
  };
}

function automated({
  id,
  channelId = 'botlog',
  title = 'Task Removed',
  description,
  source = 'cloudy',
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
      color: 0xFFFFFF,
    },
    createdAt: new Date(Number(id.replace(/\D/g, '') || 1) * 1000).toISOString(),
  };
}

test('Search collapses dynamic copies of the same automatic response into one result', () => {
  const matches = buildMatches(guild(), [
    automated({ id: '1', description: 'Task daily-reward was removed by <@111111111111111111>.' }),
    automated({ id: '2', description: 'Task cleanup-cache was removed by <@222222222222222222>.' }),
    automated({ id: '3', description: 'Task backup-logs was removed by <@333333333333333333>.' }),
  ], 'task removed');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Task Removed');
});

test('Search keeps genuinely different automatic responses with the same title separate', () => {
  const matches = buildMatches(guild(), [
    automated({ id: '10', description: 'A scheduled task was removed.' }),
    automated({ id: '11', description: 'A role reward task was removed because the role no longer exists.' }),
  ], 'task removed');

  assert.equal(matches.length, 2);
});

test('same-title Search results get useful human-readable labels instead of raw duplicate IDs', () => {
  const matches = buildMatches(guild(), [
    automated({ id: '21', description: 'A scheduled task was removed.' }),
    automated({ id: '22', description: 'A role reward task was removed because the role no longer exists.' }),
  ], 'task removed');

  const choices = buildSearchChoices(matches);
  assert.equal(choices.length, 2);
  assert.ok(choices.every(choice => choice.name.startsWith('Task Removed • ')));
  assert.ok(choices.some(choice => /scheduled task/i.test(choice.name)));
  assert.ok(choices.some(choice => /role reward/i.test(choice.name)));
  assert.ok(choices.every(choice => !/\b21\b|\b22\b/.test(choice.name)));
});

test('manual Builder embeds never collapse just because their visible content matches', () => {
  const matches = buildMatches(guild(), [
    automated({
      id: '31',
      channelId: 'general',
      title: 'Custom notice',
      description: 'Same manual content.',
      source: 'embed-builder',
    }),
    automated({
      id: '32',
      channelId: 'general',
      title: 'Custom notice',
      description: 'Same manual content.',
      source: 'embed-builder',
    }),
  ], 'custom notice');

  assert.equal(matches.length, 2);
});
