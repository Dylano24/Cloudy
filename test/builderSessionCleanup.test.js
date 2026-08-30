import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDER_SESSION_IDLE_MS,
  deleteBuilderSessionMessage,
  isBuilderSessionMessage,
  touchBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('builder inactivity timeout is exactly one minute', () => {
  assert.equal(BUILDER_SESSION_IDLE_MS, 60_000);
});

test('session cleanup only targets Message Builder and Modify Embed messages', () => {
  assert.equal(isBuilderSessionMessage({
    id: '1',
    embeds: [{ title: 'Preview' }, { title: 'Message builder' }],
  }), true);

  assert.equal(isBuilderSessionMessage({
    id: '2',
    embeds: [{ title: 'Modify embed' }],
  }), true);

  assert.equal(isBuilderSessionMessage({
    id: '3',
    embeds: [{ title: 'Changes saved' }],
  }), false);
});

test('builder cleanup deletes ephemeral messages through the interaction webhook', async () => {
  let webhookDeletes = 0;
  let directDeletes = 0;
  const message = {
    id: 'builder-session-message',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {
      directDeletes += 1;
      throw new Error('ephemeral messages cannot be deleted as normal channel messages');
    },
  };

  const touched = touchBuilderSessionMessage(message, async () => {
    webhookDeletes += 1;
  });

  assert.equal(touched, true);
  assert.equal(await deleteBuilderSessionMessage(message), true);
  assert.equal(webhookDeletes, 1);
  assert.equal(directDeletes, 0);
});
