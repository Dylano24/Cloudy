import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  buildMatches, buildSearchChoices,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';

test('new Test and older Yess remain separate physical Builder messages, without Search reverting Test', () => {
  const guildId = 'new-test-vs-old-yess-20261028';
  const channelId = '177777777777777771';
  const oldMessageId = '177777777777777772';
  const newMessageId = '177777777777777773';
  const body = 'Hahahwjjw\n\nsjsisijajaj\n\nshsjsjwjwjje';
  const footer = { text: '© Cloudy Inc. • Quality. Innovation. Performance.' };
  const old = {
    guildId, channelId, messageId: oldMessageId, embedIndex: 0,
    source: 'embed-builder', manualSaved: true, name: 'Yess', title: 'Yess',
    snapshot: {
      title: 'Yess', description: body, color: 0xff0080,
      thumbnail: { url: 'https://example.com/cloudy-c-logo.png' }, footer,
    },
    components: [],
  };
  const latest = {
    guildId, channelId, messageId: newMessageId, embedIndex: 0,
    source: 'embed-builder', manualSaved: true, name: 'Test', title: 'Test',
    snapshot: {
      title: 'Test', description: body, color: 0xffffff,
      thumbnail: { url: 'https://example.com/new-white-c.png' }, footer,
    },
    components: [],
  };
  const guild = {
    id: guildId, channels: {
      cache: new Collection([[channelId, {
        id: channelId, guildId, name: 'general',
        permissionsFor: () => ({ has: () => true }),
      }]]),
    },
  };
  const matches = buildMatches(guild, [old, latest], 'test');
  const choices = buildSearchChoices(matches);
  assert.deepEqual(choices, [{
    name: 'Test', value: channelId + ':' + newMessageId + ':0',
  }], 'the new Search item must resolve the new message ID rather than old Yess');

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, latest), true);
  assert.equal(state.title, 'Test');
  assert.equal(state.sideColor, 0xffffff);
  assert.equal(state.modifyTarget.messageId, newMessageId);
  assert.equal(state.modifyTarget.sourceEmbedData.thumbnail.url, latest.snapshot.thumbnail.url,
    'new Test keeps its own white logo; old Yess dark C must not be applied');

  const previousState = {};
  assert.equal(loadRecordSnapshotIntoState(previousState, guild, old), true);
  assert.equal(previousState.title, 'Yess');
  assert.equal(previousState.sideColor, 0xff0080);
  assert.equal(previousState.modifyTarget.messageId, oldMessageId);
  assert.equal(previousState.modifyTarget.sourceEmbedData.thumbnail.url, old.snapshot.thumbnail.url);
});
