import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldUseTransientTimer,
} from '../src/utils/interactionMessageLifecycle.js';
import {
  scheduleTransientInteractionReplyDeletion,
} from '../src/utils/transientResponse.js';

const transientPreviewPayload = {
  embeds: [{ title: 'Messages purged' }],
};

test('embedbuilder live preview is never treated as a 10-second transient status reply', () => {
  const interaction = { commandName: 'embedbuilder' };
  assert.equal(
    shouldUseTransientTimer(transientPreviewPayload, null, interaction),
    false,
  );
});

test('normal command status replies keep the 10-second transient rule', () => {
  const interaction = { commandName: 'purge' };
  assert.equal(
    shouldUseTransientTimer(transientPreviewPayload, null, interaction),
    true,
  );
});

test('fallback transient cleanup cannot delete the embedbuilder original live preview', async () => {
  let deleteCalled = false;
  const interaction = {
    commandName: 'embedbuilder',
    replied: true,
    deferred: false,
    fetchReply: async () => ({
      id: 'preview-message',
      embeds: [{ title: 'Messages purged' }],
      content: '',
    }),
    deleteReply: async () => {
      deleteCalled = true;
    },
  };

  const scheduled = await scheduleTransientInteractionReplyDeletion(interaction);

  assert.equal(scheduled, false);
  assert.equal(deleteCalled, false);
});
