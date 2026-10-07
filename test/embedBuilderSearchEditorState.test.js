import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyInitialSearchSelectionToState } from '../src/services/embedManagerService.js';

const searchPatch = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');

test('slash Search selection is applied before the Builder editor can emit updates', () => {
  assert.match(
    searchPatch,
    /interaction\.__cloudyInitialBuilderSelection\s*=\s*initialSelection/,
    'Search execute must attach the selected canonical record directly to the command interaction',
  );

  const applyIndex = builder.indexOf('applyInitialSearchSelectionToState(interaction, state)');
  const editorIndex = builder.indexOf('createEmbedColorPickerSession({');

  assert.ok(applyIndex >= 0, 'Builder must apply the initial Search selection to state');
  assert.ok(editorIndex >= 0, 'Builder editor session must exist');
  assert.ok(
    applyIndex < editorIndex,
    'Search state must be loaded before the browser editor session can send title/message updates',
  );
});

test('Search selection carries preview and source records into initial Builder state', () => {
  assert.match(searchPatch, /const initialSelection = \{\s*record,\s*previewRecord,/);
  assert.match(searchPatch, /await hydrateLiveSearchRecord\(interaction\.guild, liveCandidate\)/);
  assert.match(searchPatch, /sourceRecord:\s*record\.sourceRecord\s*\|\|\s*null/);
  const record = {
    guildId: 'search-state-guild', channelId: 'search-state-channel',
    messageId: 'catalog-master', source: 'system-catalog', embedIndex: 0,
    snapshot: { title: 'Example result', description: 'Generic source text' },
  };
  const previewRecord = {
    ...record, messageId: 'live-preview', source: 'modified-template',
    snapshot: { title: 'Example result', description: 'Hydrated runtime values', color: 0x123456 },
  };
  const sourceRecord = {
    ...record, snapshot: { ...record.snapshot, fields: [{ name: 'Source field', value: 'Complete source data' }] },
  };
  const interaction = {
    guild: { id: record.guildId, channels: { cache: new Map() } },
    __cloudyInitialBuilderSelection: { record, previewRecord, sourceRecord },
  };
  const state = {};
  assert.equal(applyInitialSearchSelectionToState(interaction, state), true);
  assert.equal(state.message, previewRecord.snapshot.description);
  assert.deepEqual(state.embedFields, [{ name: 'Source field', value: 'Complete source data', inline: false }]);
  assert.equal(state.modifyTarget.messageId, record.messageId);
  assert.equal(state.modifyTarget.previewSourceData.description, previewRecord.snapshot.description);
  assert.equal(interaction.__cloudyInitialBuilderSelection, undefined);
});
