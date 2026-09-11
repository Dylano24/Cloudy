import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { EMBED_EDITOR_IDLE_MS } from '../src/services/embedColorPickerSessionService.js';
import {
  deleteBuilderSessionMessage,
  expireBuilderSessionHold,
  runWithBuilderSessionHold,
  touchBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('editor and Embed Builder share exactly fourteen minutes of editor inactivity', () => {
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);

  const source = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');
  assert.match(source, /deleteEmbedColorPickerSession\(token, \{ expireBuilder: true \}\)/);
  assert.match(source, /real editor activity and each[\s\S]*fourteen-minute shared inactivity window/i);
});

test('browser unload cannot shorten an active editor lease to the normal five-minute Builder timer', () => {
  const page = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  assert.match(page, /EMBED_EDITOR_SHARED_14M_LEASE_V1/);
  assert.doesNotMatch(page, /beforeunload[^\n]*closeEditorSession/);
  assert.doesNotMatch(page, /document\.visibilityState !== 'visible'/);
});

test('no direct Builder cleanup can delete a message while an editor hold owns it', async () => {
  let deleted = 0;
  const message = {
    id: 'shared-lease-builder',
    embeds: [{ title: 'Message builder' }],
    delete: async () => { deleted += 1; },
  };

  await runWithBuilderSessionHold('shared-lease-test', async () => {
    touchBuilderSessionMessage(message);
  });

  assert.equal(await deleteBuilderSessionMessage(message), false);
  assert.equal(deleted, 0);

  assert.equal(await expireBuilderSessionHold('shared-lease-test'), true);
  assert.equal(deleted, 1);
});
