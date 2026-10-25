import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/utils/database.js';
import {
  saveEmbedTemplateDecoration,
  warmSavedEmbedTemplateScopes,
  getCachedSavedEmbedTemplateData,
} from '../src/services/embedTemplateService.js';
import {
  buildMatches, buildAutocompleteMatches, buildSearchChoices, recordTitle,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';

const values = new Map();
db.initialized = true;
db.useFallback = false;
db.db = {
  get: async key => structuredClone(values.get(key)),
  set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
};
const emoji = '<a:W81yesverifiedblue:123456789012345678>';

function sample() {
  const guildId = 'persist-owner-emoji-guild';
  const channelId = '123456789012345621';
  const original = {
    title: 'Removed from Builder',
    description: 'The stale record and its Reappear rule were removed from the Embed Builder.',
    color: 0x00c49d,
    fields: [{ name: 'Details', value: 'All entries were removed.', inline: false }],
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    author: {
      name: 'Cloudy template key: builder:removed || Cloudy context: embed-builder/delete || Cloudy kind: embed',
    },
  };
  const record = {
    guildId, channelId, messageId: '123456789012345622', embedIndex: 0,
    source: 'system-catalog', name: original.title, title: original.title,
    snapshot: original,
  };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, { id: channelId, name: 'general' }]]) } };
  return { guildId, channelId, original, record, guild };
}

test('Save treats the exact custom emoji in title AND message as literal, not {dynamic}', async () => {
  const { guildId, channelId, original, record, guild } = sample();
  const saved = {
    ...original,
    title: 'Removed from builder ' + emoji,
    description: 'Removed successfully ' + emoji + ' ✅',
  };
  assert.equal(await saveEmbedTemplateDecoration(guildId, channelId,
    [original.title, 'builder:removed'], saved,
    { sharedScope: true, canonicalIdentity: 'builder:removed',
      baseEmbedData: original, editedEmbedData: saved }), true);
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);

  const hydrated = getCachedSavedEmbedTemplateData(guildId, channelId, original);
  assert.equal(hydrated.matched, true);
  assert.equal(hydrated.data.title, saved.title);
  assert.equal(hydrated.data.description, saved.description);
  assert.deepEqual(hydrated.data.fields, original.fields);
  assert.equal(hydrated.data.color, 0x00c49d);
  assert.ok(!/\{dynamic\}/i.test(hydrated.data.title + hydrated.data.description));

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  assert.equal(state.title, saved.title, 'reopened live Builder preview keeps the original emoji markup');
  assert.equal(state.message, saved.description);
  assert.deepEqual(state.embedFields, saved.fields);

  const matches = buildMatches(guild, [record], 'removed from builder');
  assert.equal(matches.length, 1);
  assert.equal(recordTitle(record), saved.title);
  assert.deepEqual(buildSearchChoices(matches).map(choice => choice.name),
    ['Removed from builder ✅'], 'Search shows a visual emoji rather than raw custom markup');
  assert.equal(buildAutocompleteMatches(guild, [record], 'removed successfully').length, 1,
    'saved description is searchable too');
  assert.equal(record.snapshot.title, original.title, 'original catalog identity remains intact');
});

test('Next Save can change or REMOVE previously saved emoji without resurrecting it', async () => {
  const { guildId, channelId, original, record, guild } = sample();
  const previous = 'Removed from builder ' + emoji;
  const updated = { ...original, title: 'Removed from builder ✨',
    description: 'Second save changed the text 👋' };
  assert.equal(await saveEmbedTemplateDecoration(guildId, channelId,
    [original.title, previous, 'builder:removed'], updated,
    { sharedScope: true, canonicalIdentity: 'builder:removed',
      baseEmbedData: original, editedEmbedData: updated }), true);
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);
  const current = getCachedSavedEmbedTemplateData(guildId, channelId, original);
  assert.equal(current.data.title, updated.title);
  assert.equal(current.data.description, updated.description);
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
  assert.equal(state.title, updated.title);
  assert.equal(state.message, updated.description);
  const options = buildSearchChoices(buildMatches(guild, [record], 'removed from builder'));
  assert.deepEqual(options.map(choice => choice.name), [updated.title]);
  assert.equal(options[0].name.includes('W81yesverifiedblue'), false);
  assert.equal(options[0].name.includes('{dynamic}'), false);
});


test('saved hammer emoji wins even when a legacy catalog row still has manualSaved and old title', async () => {
  const { guildId, channelId, original, record, guild } = sample();
  const updated = { ...original, title: 'Removed from builder 🔨',
    description: 'The latest saved description 🔨' };
  assert.equal(await saveEmbedTemplateDecoration(guildId, channelId,
    [original.title, 'builder:removed'], updated,
    { sharedScope: true, canonicalIdentity: 'builder:removed',
      baseEmbedData: original, editedEmbedData: updated }), true);
  await warmSavedEmbedTemplateScopes(guildId, [channelId]);
  const legacy = { ...record, manualSaved: true, source: 'system-catalog' };
  assert.equal(recordTitle(legacy), updated.title);
  const choices = buildSearchChoices(buildMatches(guild, [legacy], 'removed from builder'));
  assert.deepEqual(choices.map(item => item.name), [updated.title]);
  assert.equal(legacy.snapshot.title, original.title, 'never rewrite the original Discord/canonical snapshot');

  const userPost = { ...legacy, source: 'embed-builder', manualSaved: true };
  assert.equal(recordTitle(userPost), original.title,
    'an owner-authored physical Builder message retains its exact title');
});
