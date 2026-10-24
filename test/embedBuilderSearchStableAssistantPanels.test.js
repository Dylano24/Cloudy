import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guild = {
  id: 'release-panel-guild',
  channels: {
    cache: new Map([['fix', { id: 'fix', name: 'fix-guide', parent: null }]]),
  },
};

test('Search keeps the live FAQ/Fix Guide panel even before canonical identity is attached', () => {
  const panel = {
    guildId: guild.id,
    channelId: 'fix',
    messageId: '900000000000000001',
    embedIndex: 0,
    source: 'bot-history',
    snapshot: {
      title: 'Cloudy Assistant • Fix Guide',
      description: 'Complete live Fix Guide panel.',
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    },
    components: [{
      components: [{
        custom_id: 'cloudy_fix_guide_ask',
        label: 'Ask',
        style: 2,
      }],
    }],
  };

  const matches = buildMatches(guild, [panel], 'fix guide');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, panel.messageId);
  assert.equal(matches[0].record.snapshot.description, 'Complete live Fix Guide panel.');
});

test('Search hides stale dynamic assistant-answer catalog rows that can compete with the real panels', () => {
  const stale = {
    guildId: guild.id,
    channelId: 'fix',
    messageId: '900000000000000002',
    embedIndex: 0,
    source: 'system-catalog',
    snapshot: {
      title: 'Cloudy Fix Guide',
      description: '{dynamic}',
    },
  };

  assert.equal(buildMatches(guild, [stale], 'fix guide').length, 0);
  assert.deepEqual(buildSearchChoices(buildMatches(guild, [stale], 'fix guide')), []);
});
