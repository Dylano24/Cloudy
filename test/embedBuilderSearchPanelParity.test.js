import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const guild = {
  id: 'panel-search-guild',
  channels: {
    cache: new Map([[
      '100000000000000001',
      { id: '100000000000000001', name: 'fix-guide', parent: null },
    ]]),
  },
};

test('Search includes a canonical live bot panel with components and its complete snapshot', () => {
  const panel = {
    guildId: guild.id,
    channelId: '100000000000000001',
    messageId: '900000000000000001',
    embedIndex: 0,
    source: 'bot-history',
    canonicalIdentity: 'panel:fix-guide',
    name: 'Cloudy Assistant • Fix Guide',
    snapshot: {
      title: 'Cloudy Assistant • Fix Guide',
      description: 'Full panel description with all instructions.',
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
      color: 0xFFFFFF,
    },
    components: [{
      type: 1,
      components: [{
        type: 2,
        custom_id: 'cloudy_fix_guide_ask',
        label: 'Ask',
        style: 2,
      }],
    }],
  };

  const matches = buildMatches(guild, [panel], 'fix guide');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, panel.messageId);
  assert.equal(matches[0].record.snapshot.description, panel.snapshot.description);
  assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name), [
    'Cloudy assistant fix guide',
  ]);
});

test('Search still hides ordinary bot-history runtime noise with no persistent panel components', () => {
  const runtime = {
    guildId: guild.id,
    channelId: '100000000000000001',
    messageId: '900000000000000002',
    embedIndex: 0,
    source: 'bot-history',
    canonicalIdentity: 'runtime:temporary',
    name: 'Temporary runtime response',
    snapshot: {
      title: 'Temporary runtime response',
      description: 'One-off runtime output.',
    },
    components: [],
  };

  assert.equal(buildMatches(guild, [runtime], 'temporary runtime').length, 0);
});
