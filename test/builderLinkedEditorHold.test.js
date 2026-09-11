import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCurrentBuilderSessionHold, runWithBuilderSessionHold, linkBuilderSessionMessages,
  touchBuilderSessionMessage, deleteBuilderSessionMessage, isBuilderSessionHeld,
  expireBuilderSessionHold, scheduleBuilderSessionHoldExpiry,
} from '../src/utils/builderSessionCleanup.js';
import { createEmbedColorPickerSession, applyEmbedColorPickerSession } from '../src/services/embedColorPickerSessionService.js';

let nextId = 0;
function message(title = 'Message builder') {
  return { id: `linked-test-${++nextId}`, embeds: [{ title }], deleted: 0,
    async delete() { this.deleted++; } };
}
const flush = () => new Promise(resolve => { setImmediate(resolve); });

for (const lateChild of [false, true]) {
  test(`real editor activity protects parent and ${lateChild ? 'later' : 'existing'} Modify embed until 14-minute expiry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const parent = message();
    const child = message('Modify embed');
    touchBuilderSessionMessage(parent);
    if (!lateChild) {
      touchBuilderSessionMessage(child);
      linkBuilderSessionMessages(parent, child);
    }
    const token = createEmbedColorPickerSession({
      userId: 'test', onEditorUpdate: async () => {},
      onEditorHold: () => acquireCurrentBuilderSessionHold(parent),
    });
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', { editorInstanceId: 'page' });
    if (lateChild) {
      touchBuilderSessionMessage(child);
      linkBuilderSessionMessages(parent, child);
    }
    assert.equal(isBuilderSessionHeld(child.id), true);
    t.mock.timers.tick(4 * 60_000);
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_ACTIVITY__', { editorInstanceId: 'page' });
    t.mock.timers.tick(13 * 60_000);
    await flush();
    assert.equal(parent.deleted, 0);
    assert.equal(child.deleted, 0);
    assert.equal(await deleteBuilderSessionMessage(child), false);
    // Heartbeats do not extend the inactivity deadline.
    await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', { editorInstanceId: 'page' });
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(parent.deleted, 1);
    assert.equal(child.deleted, 1);
  });
}

test('linking a child preserves the existing five-minute post-close expiry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = message();
  const child = message('Modify embed');
  await runWithBuilderSessionHold('closed-hold', () => acquireCurrentBuilderSessionHold(parent));
  scheduleBuilderSessionHoldExpiry('closed-hold');
  t.mock.timers.tick(60_000);
  linkBuilderSessionMessages(parent, child);
  t.mock.timers.tick(4 * 60_000);
  await flush();
  assert.equal(parent.deleted, 1);
  assert.equal(child.deleted, 1);
});

test('independent Builders retain their normal five-minute timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = message();
  const child = message('Modify embed');
  const unrelated = message();
  linkBuilderSessionMessages(parent, child);
  touchBuilderSessionMessage(unrelated);
  await runWithBuilderSessionHold('isolated-hold', () => acquireCurrentBuilderSessionHold(parent));
  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(unrelated.deleted, 1);
  assert.equal(parent.deleted, 0);
  assert.equal(child.deleted, 0);
  await expireBuilderSessionHold('isolated-hold');
});

test('a second editor hold still protects both messages when the first expires', async () => {
  const parent = message();
  const child = message('Modify embed');
  linkBuilderSessionMessages(parent, child);
  await runWithBuilderSessionHold('first-hold', () => acquireCurrentBuilderSessionHold(parent));
  await runWithBuilderSessionHold('second-hold', () => acquireCurrentBuilderSessionHold(child));
  await expireBuilderSessionHold('first-hold');
  assert.equal(isBuilderSessionHeld(parent.id), true);
  assert.equal(isBuilderSessionHeld(child.id), true);
  assert.equal(parent.deleted + child.deleted, 0);
  await expireBuilderSessionHold('second-hold');
  assert.equal(parent.deleted, 1);
  assert.equal(child.deleted, 1);
});
