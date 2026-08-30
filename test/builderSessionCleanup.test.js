import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDER_SESSION_IDLE_MS,
  isBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('builder inactivity timeout is exactly two minutes', () => {
  assert.equal(BUILDER_SESSION_IDLE_MS, 120_000);
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
