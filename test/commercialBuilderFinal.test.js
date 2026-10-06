import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBuilderMessageComponents,
  loadBuilderComponentsFromRecord,
  removeRightmostBuilderButton,
} from '../src/services/embedBuilderButtonEditorService.js';
import { hydrateBuilderPreviewRecord } from '../src/services/builderRuntimePreviewService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

function row(...labels) {
  return {
    type: 1,
    components: labels.map((label, index) => ({
      type: 2,
      style: 2,
      custom_id: `button_${label.toLowerCase()}_${index}`,
      label,
    })),
  };
}

test('existing live preview components hydrate without marking Save dirty', () => {
  const state = { componentRows: [], componentRowsSourceMessageId: 'new', componentsDirty: true };
  const record = { messageId: 'live-message', components: [row('Ask a question', 'YouTube')] };

  assert.equal(loadBuilderComponentsFromRecord(state, record), true);
  assert.equal(state.componentsDirty, false);
  assert.equal(state.componentRowsSourceMessageId, 'live-message');
  assert.deepEqual(
    getBuilderMessageComponents(state).map(item => item.components.map(component => component.label)),
    [['Ask a question', 'YouTube']],
  );
});

test('Remove button removes exactly one button from right to left', () => {
  let rows = [row('A', 'B'), row('C', 'D')];
  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A', 'B'], ['C']]);
  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A', 'B']]);
  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A']]);
});

test('live Discord peer always wins over a saved runtime preview', async () => {
  const live = {
    messageId: 'faq-panel',
    source: 'reconciled',
    snapshot: {
      title: 'Cloudy support assistant',
      description: 'Have a question or need help with something?',
    },
  };
  const catalog = {
    channelId: 'faq',
    messageId: 'catalog-template',
    source: 'system-catalog',
    snapshot: { title: 'Cloudy support assistant' },
  };

  const result = await hydrateBuilderPreviewRecord(
    { id: 'guild', client: {} },
    catalog,
    live,
    'user',
  );

  assert.equal(result, live);
  assert.equal(result.snapshot.description.includes('Jouw vraag'), false);
});

test('Search collapses only exact automated duplicates and keeps different content', () => {
  const guild = {
    channels: {
      cache: new Map([['botlog', { id: 'botlog', name: 'botlog', parent: null }]]),
    },
  };
  const base = {
    guildId: 'guild',
    channelId: 'botlog',
    embedIndex: 0,
    source: 'cloudy',
    title: 'Task Removed',
    name: 'Task Removed',
  };

  const matches = buildMatches(guild, [
    { ...base, messageId: '1', snapshot: { title: 'Task Removed', description: 'Task A removed.' } },
    { ...base, messageId: '2', snapshot: { title: 'Task Removed', description: 'Task A removed.' } },
    { ...base, messageId: '3', snapshot: { title: 'Task Removed', description: 'Task B removed.' } },
  ], 'task removed');

  assert.equal(matches.length, 2);
});
