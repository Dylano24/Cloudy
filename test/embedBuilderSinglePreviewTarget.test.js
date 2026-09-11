import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { editBuilderPreviewMessage } from '../src/commands/Tools/embedbuilder.js';
import { BUILDER_SESSION_IDLE_MS } from '../src/utils/builderSessionCleanup.js';

test('Embed Builder preview always edits the original fixed message target', async () => {
  const edits = [];
  let directEdits = 0;
  let followUps = 0;
  const state = {
    builderMessageId: 'original-builder-message',
    builderWebhook: {
      editMessage: async (messageId, payload) => {
        edits.push({ messageId, payload });
      },
    },
    builderPreviewUnavailable: false,
    colorSessionToken: null,
  };
  const unrelatedInteraction = {
    editReply: async () => { directEdits += 1; },
    followUp: async () => { followUps += 1; },
  };

  for (let index = 0; index < 50; index += 1) {
    const ok = await editBuilderPreviewMessage(state, unrelatedInteraction, {
      content: `preview-${index}`,
    });
    assert.equal(ok, true);
  }

  assert.equal(edits.length, 50);
  assert.equal(edits.every(edit => edit.messageId === 'original-builder-message'), true);
  assert.equal(directEdits, 0);
  assert.equal(followUps, 0);
});

test('a missing original Builder preview never creates a replacement follow-up', async () => {
  let followUps = 0;
  let directEdits = 0;
  const missing = new Error('Unknown Message');
  missing.code = 10008;

  const state = {
    builderMessageId: 'deleted-builder-message',
    builderWebhook: {
      editMessage: async () => { throw missing; },
    },
    builderPreviewUnavailable: false,
    colorSessionToken: null,
  };
  const interaction = {
    editReply: async () => { directEdits += 1; },
    followUp: async () => { followUps += 1; },
  };

  assert.equal(await editBuilderPreviewMessage(state, interaction, { content: 'new state' }), false);
  assert.equal(state.builderPreviewUnavailable, true);
  assert.equal(directEdits, 0);
  assert.equal(followUps, 0);

  assert.equal(await editBuilderPreviewMessage(state, interaction, { content: 'later state' }), false);
  assert.equal(followUps, 0);
});

test('single-preview fix leaves the Builder/shared editor timers unchanged', () => {
  const serviceSource = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.equal(BUILDER_SESSION_IDLE_MS, 5 * 60_000);
  assert.match(serviceSource, /export const EMBED_EDITOR_IDLE_MS = 14 \* 60_000;/);
});
