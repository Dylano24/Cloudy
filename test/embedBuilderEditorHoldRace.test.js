import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireCurrentBuilderSessionHold,
  deleteBuilderSessionMessage,
  releaseBuilderSessionHold,
  runWithBuilderSessionHold,
} from '../src/utils/builderSessionCleanup.js';

test('registered editor hold hard-blocks builder deletion until the hold is released', async () => {
  let deletes = 0;
  const message = {
    id: '999999999999999999',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {
      deletes += 1;
    },
  };

  await runWithBuilderSessionHold('editor-race-test', async () => {
    assert.equal(acquireCurrentBuilderSessionHold(message), true);
  });

  assert.equal(await deleteBuilderSessionMessage(message), false);
  assert.equal(deletes, 0);

  assert.equal(releaseBuilderSessionHold('editor-race-test'), true);
  assert.equal(await deleteBuilderSessionMessage(message), true);
  assert.equal(deletes, 1);
});

test('runtime builder hold callback binds directly instead of depending on refreshBuilder queue timing', () => {
  const builderSource = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const cleanupSource = fs.readFileSync('src/utils/builderSessionCleanup.js', 'utf8');

  assert.match(builderSource, /EDITOR_OPEN_HOLD_RACE_V3/);
  assert.match(builderSource, /acquireCurrentBuilderSessionHold\([\s\S]*state\.builderMessage/);
  assert.match(builderSource, /state\.builderMessage\s*=\s*dashboardMessage/);
  assert.doesNotMatch(
    builderSource,
    /onEditorHold:\s*async \(\) => \{[^}]*const refreshed = await refreshBuilder/s,
  );

  assert.match(cleanupSource, /EDITOR_OPEN_HOLD_RACE_V3/);
  assert.match(cleanupSource, /if \(isBuilderSessionHeld\(key\)\) return false;/);
});
