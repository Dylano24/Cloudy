import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySavedResponsePayloadTemplates,
  applyTemplatesToExistingMessage,
} from '../src/events/fullResponseCatalogReady.js';

test('staff robbery denial bypasses standard failed robbery template overlays', async () => {
  const payload = {
    embeds: [{ title: 'Robbery failed', description: 'Cloudy staff members cannot be robbed.' }],
  };
  const result = await applySavedResponsePayloadTemplates(payload, {
    guildId: '1532882647838228723', channelId: '1533188412507558130',
  });
  assert.strictEqual(result, payload);
  assert.equal(result.embeds[0].description, 'Cloudy staff members cannot be robbed.');
});

test('staff robbery denial is never post-send rewritten as a fined robbery', async () => {
  const message = {
    embeds: [{ title: 'Robbery failed', description: 'Cloudy staff members cannot be robbed.' }],
    guildId: '1532882647838228723',
    channelId: '1533188412507558130',
    editable: true,
  };
  assert.equal(await applyTemplatesToExistingMessage(message, { initialCreation: true }), false);
});
