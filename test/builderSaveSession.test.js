import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { embedColorPickerPage } from '../src/web/embedColorPickerPage.js';
import { createEmbedColorPickerSession, applyEmbedColorPickerSession, flushPendingEmbedEditorUpdates, deleteEmbedColorPickerSession } from '../src/services/embedColorPickerSessionService.js';

test('410 stops heartbeat, focus, visibility and subsequent editor requests without affecting a fresh page', async () => {
  async function page(status) {
    let requests = 0, cleared = 0;
    const events = new Map();
    const context = vm.createContext({ URLSearchParams, location: { search: '?session=test' }, setInterval: callback => { events.set('timer', callback); return 1; }, clearInterval: () => { cleared++; },
      window: { addEventListener: (name, callback) => events.set(name, callback) }, document: { visibilityState: 'visible', addEventListener: (name, callback) => events.set(name, callback) },
      fetch: async () => { requests++; return { status, ok: status === 200, json: async () => ({ color: 'ok' }) }; }, navigator: {} });
    const script = embedColorPickerPage().split('<script>')[1].split('    let editorCloseSent')[0];
    vm.runInContext(script + '\n editorOpenPromise.catch(() => {});', context);
    await new Promise(resolve => setImmediate(resolve));
    for (const name of ['timer', 'focus', 'visibilitychange', 'timer']) { events.get(name)(); await new Promise(resolve => setImmediate(resolve)); }
    return { requests, cleared };
  }
  assert.deepEqual(await page(410), { requests: 1, cleared: 1 });
  assert.deepEqual(await page(200), { requests: 5, cleared: 0 });
});

test('failed drain retains accepted fields and a later flush retries them in order', async () => {
  const applied = [];
  let fail = true;
  const token = createEmbedColorPickerSession({ userId: 'owner', onEditorHold: async () => {}, onEditorUpdate: async (field, value) => {
    if (fail) throw new Error('temporary failure');
    applied.push([field, value]);
  } });
  try {
    for (const [field, value] of [['title', 'Saved title'], ['message', 'Saved message']]) {
      await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field, value }));
    }
    await assert.rejects(flushPendingEmbedEditorUpdates(token), /temporary failure/);
    fail = false;
    await flushPendingEmbedEditorUpdates(token);
    assert.deepEqual(applied, [['title', 'Saved title'], ['message', 'Saved message']]);
  } finally { deleteEmbedColorPickerSession(token); }
});
