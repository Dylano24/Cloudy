import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBuilderMessageComponents,
  getBuilderPreviewComponents,
  loadBuilderComponentsFromRecord,
  removeRightmostBuilderButton,
} from '../src/services/embedBuilderButtonEditorService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { hydrateBuilderPreviewRecord, rememberBuilderRuntimePreview } from '../src/services/builderRuntimePreviewService.js';
import { db } from '../src/utils/database.js';
import { getEmbedRegistry, registerCloudyEmbedMessage } from '../src/services/embedRegistryService.js';

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

test('existing embed components hydrate into live preview state without marking them dirty', () => {
  const state = {
    componentRows: [],
    componentRowsSourceMessageId: 'new',
    componentsDirty: true,
  };
  const record = {
    messageId: 'existing-message',
    components: [row('Ask a question', 'YouTube')],
  };

  assert.equal(loadBuilderComponentsFromRecord(state, record), true);
  assert.equal(state.componentRowsSourceMessageId, 'existing-message');
  assert.equal(state.componentsDirty, false);
  assert.deepEqual(
    getBuilderMessageComponents(state).map(item => item.components.map(component => component.label)),
    [['Ask a question', 'YouTube']],
  );
});

test('Remove button removes exactly one button from right to left across rows', () => {
  let rows = [row('A', 'B'), row('C', 'D')];

  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A', 'B'], ['C']]);

  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A', 'B']]);

  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows.map(item => item.components.map(component => component.label)), [['A']]);

  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows, []);

  rows = removeRightmostBuilderButton(rows);
  assert.deepEqual(rows, []);
});

test('Search collapses exact automated duplicates in one channel', () => {
  const guild = {
    channels: {
      cache: new Map([['botlog', { id: 'botlog', name: 'botlog', parent: null }]]),
    },
  };
  const snapshot = {
    title: 'Task Removed',
    description: 'Task removed from #botlog.',
    color: 0xFFFFFF,
  };
  const records = [
    {
      guildId: 'guild',
      channelId: 'botlog',
      messageId: 'auto-1',
      embedIndex: 0,
      source: 'modified',
      title: 'Task Removed',
      name: 'Task Removed',
      snapshot,
      createdAt: '2026-10-06T08:00:00.000Z',
    },
    {
      guildId: 'guild',
      channelId: 'botlog',
      messageId: 'auto-2',
      embedIndex: 0,
      source: 'cloudy',
      title: 'Task Removed',
      name: 'Task Removed',
      snapshot,
      createdAt: '2026-10-06T08:01:00.000Z',
    },
  ];

  const matches = buildMatches(guild, records, 'task removed');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Task Removed');
});

test('Search never collapses manual embeds or automated embeds with different content', () => {
  const guild = {
    channels: {
      cache: new Map([['general', { id: 'general', name: 'general', parent: null }]]),
    },
  };

  const manual = [
    {
      guildId: 'guild',
      channelId: 'general',
      messageId: 'manual-1',
      embedIndex: 0,
      source: 'embed-builder',
      title: 'Same title',
      name: 'Same title',
      snapshot: { title: 'Same title', description: 'One' },
    },
    {
      guildId: 'guild',
      channelId: 'general',
      messageId: 'manual-2',
      embedIndex: 0,
      source: 'embed-builder',
      title: 'Same title',
      name: 'Same title',
      snapshot: { title: 'Same title', description: 'One' },
    },
  ];
  assert.equal(buildMatches(guild, manual, 'same title').length, 2);

  const automated = [
    {
      guildId: 'guild',
      channelId: 'general',
      messageId: 'auto-1',
      embedIndex: 0,
      source: 'modified',
      title: 'Task Removed',
      name: 'Task Removed',
      snapshot: { title: 'Task Removed', description: 'First task' },
    },
    {
      guildId: 'guild',
      channelId: 'general',
      messageId: 'auto-2',
      embedIndex: 0,
      source: 'cloudy',
      title: 'Task Removed',
      name: 'Task Removed',
      snapshot: { title: 'Task Removed', description: 'Second task' },
    },
  ];
  assert.equal(buildMatches(guild, automated, 'task removed').length, 2);
});


test('existing button preview copy keeps real actions inert', () => {
  const state = {
    componentRows: [row('Ask a question', 'YouTube')],
  };
  const preview = getBuilderPreviewComponents(state);

  assert.equal(preview[0].components[0].label, 'Ask a question');
  assert.equal(preview[0].components[1].label, 'YouTube');
  assert.equal(preview[0].components[0].disabled, true);
  assert.equal(preview[0].components[1].disabled, true);

  const saved = getBuilderMessageComponents(state);
  assert.equal(Boolean(saved[0].components[0].disabled), false);
  assert.equal(Boolean(saved[0].components[1].disabled), false);
});


test('final Railway Builder source preserves commercial button contracts', async () => {
  const fs = await import('node:fs');
  const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const manager = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const registry = fs.readFileSync('src/services/embedRegistryService.js', 'utf8');

  assert.match(builder, /\.setLabel\('Remove button'\)/);
  assert.match(builder, /removeRightmostBuilderButton\(state\.componentRows\)/);
  assert.match(builder, /components:\s*getBuilderPreviewComponents\(state\)/);
  assert.match(builder, /BUILDER_EXISTING_BUTTON_PREVIEW_V1/);
  assert.match(builder, /hydrateBuilderMessageComponents\(interaction\.guild, state\)/);

  assert.match(manager, /loadBuilderComponentsFromRecord\(state, record\)/);
  assert.match(manager, /loadBuilderComponentsFromMessage\(state, message\)/);
  assert.match(manager, /hydrateBuilderMessageComponents\(guild, state\)/);

  assert.match(registry, /components:\s*normalizeMessageComponents\(message\.components\)/);
});


test('same Builder rules apply across embed families instead of one hard-coded title', () => {
  const channelIds = ['botlog', 'logs', 'economy', 'tickets'];
  const guild = {
    channels: {
      cache: new Map(channelIds.map(id => [id, { id, name: id, parent: null }])),
    },
  };

  const automatedFamilies = [
    ['Task Removed', 'Task removed from #botlog.'],
    ['Verification Removed', 'Verification access was removed.'],
    ['Role Reward Removed', 'Role reward was removed.'],
  ];

  for (const [title, description] of automatedFamilies) {
    const records = [
      {
        guildId: 'guild',
        channelId: 'botlog',
        messageId: `${title}-1`,
        embedIndex: 0,
        source: 'modified',
        title,
        name: title,
        snapshot: { title, description, color: 0xFFFFFF },
      },
      {
        guildId: 'guild',
        channelId: 'logs',
        messageId: `${title}-2`,
        embedIndex: 0,
        source: 'cloudy',
        title,
        name: title,
        snapshot: { title, description, color: 0xFFFFFF },
      },
    ];

    assert.equal(buildMatches(guild, records, title).length, 1, title);
  }

  const templateRecords = ['crime', 'beg', 'work'].map((channelId, index) => ({
    guildId: 'guild',
    channelId,
    messageId: `too-fast-${index}`,
    embedIndex: 0,
    source: 'modified-template',
    title: 'Too fast',
    name: 'Too fast',
    snapshot: {
      title: 'Too fast',
      description: ['Jail cooldown', 'Beg cooldown', 'Work cooldown'][index],
    },
  }));
  guild.channels.cache.set('crime', { id: 'crime', name: 'crime', parent: null });
  guild.channels.cache.set('beg', { id: 'beg', name: 'beg', parent: null });
  guild.channels.cache.set('work', { id: 'work', name: 'work', parent: null });

  assert.equal(buildMatches(guild, templateRecords, 'too fast').length, 1);

  const manualRecords = automatedFamilies.map(([title, description], index) => ({
    guildId: 'guild',
    channelId: 'tickets',
    messageId: `manual-${index}`,
    embedIndex: 0,
    source: 'embed-builder',
    title,
    name: title,
    snapshot: { title, description },
  }));
  assert.equal(buildMatches(guild, manualRecords, '').length, manualRecords.length);
});


test('live existing embed wins over same-title runtime response preview for every panel', async () => {
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async () => null,
    set: async () => true,
    delete: async () => true,
    list: async () => [],
  };

  const guild = { id: 'guild-live', client: {} };
  const livePanel = {
    guildId: 'guild-live',
    channelId: 'faq',
    messageId: 'panel-message',
    embedIndex: 0,
    source: 'cloudy',
    title: 'Cloudy support assistant',
    snapshot: {
      title: 'Cloudy support assistant',
      description: 'Have a question or need help with something?',
    },
  };

  await rememberBuilderRuntimePreview({
    embeds: [{
      title: 'Cloudy support assistant',
      description: 'Temporary AI answer',
      fields: [{ name: 'Jouw vraag', value: 'Ik heb mijn producten niet ontvangen' }],
    }],
  }, { guildId: 'guild-live', channelId: 'faq' });

  const hydrated = await hydrateBuilderPreviewRecord(guild, livePanel, livePanel, 'user');
  assert.equal(hydrated.messageId, 'panel-message');
  assert.equal(hydrated.snapshot.description, 'Have a question or need help with something?');
  assert.equal(hydrated.snapshot.fields, undefined);
});

test('registry persists existing message components for instant Builder preview hydration', async () => {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };

  const message = {
    id: 'faq-panel',
    guildId: 'guild-components',
    channelId: 'faq',
    author: { id: 'cloudy-bot' },
    client: { user: { id: 'cloudy-bot' } },
    channel: { id: 'faq', name: 'faq' },
    createdAt: new Date('2026-10-06T09:00:00.000Z'),
    flags: { has: () => false },
    embeds: [{
      title: 'Cloudy support assistant',
      description: 'Have a question or need help with something?',
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    }],
    components: [row('Ask a question')],
  };

  assert.equal(await registerCloudyEmbedMessage(message, 'bot-history'), true);
  const records = await getEmbedRegistry('guild-components');
  const record = records.find(item => item.messageId === 'faq-panel');
  assert.ok(record);
  assert.equal(record.components?.[0]?.components?.[0]?.label, 'Ask a question');
});
