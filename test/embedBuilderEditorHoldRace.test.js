import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireCurrentBuilderSessionHold,
  deleteBuilderSessionMessage,
  releaseBuilderSessionHold,
  runWithBuilderSessionHold,
  scheduleBuilderSessionHoldExpiry,
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

test('post-close protection keeps Builder held until its protected window expires', async () => {
  let deletes = 0;
  const message = {
    id: '999999999999999998',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {
      deletes += 1;
    },
  };

  await runWithBuilderSessionHold('post-close-test', async () => {
    assert.equal(acquireCurrentBuilderSessionHold(message), true);
  });

  assert.equal(scheduleBuilderSessionHoldExpiry('post-close-test', 40), true);
  assert.equal(await deleteBuilderSessionMessage(message), false);
  assert.equal(deletes, 0);

  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deletes, 1);
});

test('reopening the editor cancels a scheduled post-close Builder expiry', async () => {
  let deletes = 0;
  const message = {
    id: '999999999999999997',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {
      deletes += 1;
    },
  };

  await runWithBuilderSessionHold('reopen-test', async () => {
    assert.equal(acquireCurrentBuilderSessionHold(message), true);
  });
  assert.equal(scheduleBuilderSessionHoldExpiry('reopen-test', 40), true);

  await new Promise(resolve => setTimeout(resolve, 10));
  await runWithBuilderSessionHold('reopen-test', async () => {
    assert.equal(acquireCurrentBuilderSessionHold(message), true);
  });

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(deletes, 0);

  assert.equal(releaseBuilderSessionHold('reopen-test'), true);
  assert.equal(await deleteBuilderSessionMessage(message), true);
  assert.equal(deletes, 1);
});

test('runtime builder hold callback binds directly instead of depending on refreshBuilder queue timing', () => {
  const builderSource = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const cleanupSource = fs.readFileSync('src/utils/builderSessionCleanup.js', 'utf8');
  const sessionSource = fs.readFileSync('src/services/embedColorPickerSessionService.js', 'utf8');

  assert.match(builderSource, /EDITOR_OPEN_HOLD_RACE_V3/);
  assert.match(builderSource, /acquireCurrentBuilderSessionHold\([\s\S]*state\.builderMessage/);
  assert.match(builderSource, /state\.builderMessage\s*=\s*dashboardMessage/);
  assert.doesNotMatch(
    builderSource,
    /onEditorHold:\s*async \(\) => \{[^}]*const refreshed = await refreshBuilder/s,
  );

  assert.match(cleanupSource, /EDITOR_OPEN_HOLD_RACE_V3/);
  assert.match(cleanupSource, /EDITOR_POST_CLOSE_FIVE_MIN_V1/);
  assert.match(cleanupSource, /if \(isBuilderSessionHeld\(key\)\) return false;/);
  assert.match(cleanupSource, /scheduleBuilderSessionHoldExpiry/);

  assert.match(sessionSource, /EDITOR_POST_CLOSE_FIVE_MIN_V1/);
  assert.match(
    sessionSource,
    /scheduleBuilderSessionHoldExpiry\(\s*token,\s*BUILDER_SESSION_IDLE_MS,\s*\)/s,
  );
});
