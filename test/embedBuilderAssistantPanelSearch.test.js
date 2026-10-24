import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMatches,
  buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function guild(channelId = '100000000000000001') {
  return {
    id: 'guild',
    channels: {
      cache: new Map([[channelId, { id: channelId, name: 'assistant', parent: null }]]),
    },
  };
}

function panelRecord({
  messageId,
  title,
  customId,
  source = 'bot-history',
  channelId = '100000000000000001',
  description = 'Full panel description.',
}) {
  return {
    guildId: 'guild',
    channelId,
    messageId,
    embedIndex: 0,
    source,
    title,
    name: title,
    snapshot: {
      title,
      description,
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    },
    components: customId ? [{
      type: 1,
      components: [{ type: 2, custom_id: customId, label: 'Action', style: 2 }],
    }] : [],
  };
}

test('Search includes live Fix Guide panel without requiring canonicalIdentity', () => {
  const g = guild();
  const record = panelRecord({
    messageId: '100000000000000010',
    title: 'Cloudy Assistant • Fix Guide',
    customId: 'cloudy_fix_guide_ask',
    description: 'The complete fixed Fix Guide panel description.',
  });

  const matches = buildMatches(g, [record], 'fix guide');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, record.messageId);
  assert.equal(matches[0].record.snapshot.description, 'The complete fixed Fix Guide panel description.');
  assert.deepEqual(
    buildSearchChoices(matches).map(choice => choice.name),
    ['Cloudy assistant fix guide'],
  );
});

test('Search excludes generated Cloudy Fix Guide runtime answer catalogs', () => {
  const g = guild();
  const runtimeAnswer = panelRecord({
    messageId: '100000000000000011',
    title: 'Cloudy Fix Guide',
    source: 'system-catalog',
    customId: null,
    description: 'A generated AI answer, not the persistent panel.',
  });

  assert.deepEqual(buildMatches(g, [runtimeAnswer], 'fix guide'), []);
});

test('Search includes the live FAQ panel and excludes generated FAQ answer catalogs', () => {
  const g = guild();
  const livePanel = panelRecord({
    messageId: '100000000000000012',
    title: 'Cloudy Support Assistant',
    customId: 'faq_ai_question',
    description: 'The complete FAQ panel.',
  });
  const runtimeAnswer = panelRecord({
    messageId: '100000000000000013',
    title: 'Cloudy Support Assistant',
    source: 'system-catalog',
    customId: null,
    description: 'Generated answer body.',
  });

  const matches = buildMatches(g, [runtimeAnswer, livePanel], 'support assistant');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.messageId, livePanel.messageId);
  assert.equal(matches[0].record.snapshot.description, 'The complete FAQ panel.');
});

test('Search does not re-introduce runtime ticket control messages as stable panels', () => {
  const g = guild();
  const ticketRuntime = panelRecord({
    messageId: '100000000000000014',
    title: 'Ticket #42',
    customId: 'ticket_claim',
    description: 'Runtime ticket instance.',
  });

  assert.deepEqual(buildMatches(g, [ticketRuntime], 'ticket'), []);
});
