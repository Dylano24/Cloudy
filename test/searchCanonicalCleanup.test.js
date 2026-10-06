import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guild = {
  channels: {
    cache: new Map([
      ['botlog', { id: 'botlog', name: 'botlog', parent: { name: 'Logs' } }],
      ['general', { id: 'general', name: 'general', parent: null }],
    ]),
  },
};

function record(overrides = {}) {
  return {
    guildId: 'guild',
    channelId: 'botlog',
    messageId: '1',
    embedIndex: 0,
    source: 'cloudy',
    title: 'Task Removed',
    name: 'Task Removed',
    snapshot: {
      title: 'Task Removed',
      description: 'Task Daily cleanup was removed from <#123456789012345678>.',
      fields: [{ name: 'Removed by', value: '<@123456789012345678>' }],
    },
    ...overrides,
  };
}

test('Search collapses repeated automated status instances into one canonical result', () => {
  const records = [
    record({ messageId: '1' }),
    record({
      messageId: '2',
      source: 'modified',
      snapshot: {
        title: 'Task Removed',
        description: 'Task Welcome cleanup was removed from <#223456789012345678>.',
        fields: [{ name: 'Removed by', value: '<@223456789012345678>' }],
      },
    }),
    record({
      messageId: '3',
      source: 'reconciled',
      snapshot: {
        title: 'Task Removed',
        description: 'Task Verification cleanup was removed from <#323456789012345678>.',
        fields: [{ name: 'Removed by', value: '<@323456789012345678>' }],
      },
    }),
  ];

  const matches = buildMatches(guild, records, 'removed');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Task Removed');
});

test('Search keeps generic same-title bot responses separate when their meaning differs', () => {
  const records = [
    record({
      channelId: 'general',
      messageId: 'success-1',
      title: 'Success',
      name: 'Success',
      snapshot: { title: 'Success', description: 'Money deposited successfully.' },
    }),
    record({
      channelId: 'general',
      messageId: 'success-2',
      title: 'Success',
      name: 'Success',
      snapshot: { title: 'Success', description: 'Ticket owner changed successfully.' },
    }),
  ];

  assert.equal(buildMatches(guild, records, 'success').length, 2);
});

test('Search never collapses manual Builder embeds just because their title matches', () => {
  const records = [
    record({ channelId: 'general', messageId: 'manual-1', source: 'embed-builder' }),
    record({ channelId: 'general', messageId: 'manual-2', source: 'embed-builder' }),
  ];

  assert.equal(buildMatches(guild, records, 'task removed').length, 2);
});

test('Search keeps useful Invalid/Error catalog-style messages searchable', () => {
  const records = [
    record({
      messageId: 'invalid-1',
      title: 'Invalid code',
      name: 'Invalid code',
      snapshot: {
        title: 'Invalid code',
        description: 'That code is invalid or no longer available.',
      },
    }),
  ];

  const matches = buildMatches(guild, records, 'invalid');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Invalid code');
});
