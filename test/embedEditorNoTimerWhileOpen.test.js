import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_EDITOR_IDLE_MS,
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
  getEmbedEditorMedia,
} from '../src/services/embedColorPickerSessionService.js';

const page = id => ({ editorInstanceId: id });
const open = id => `__CLOUDY_EMBED_OPEN__:${id}`;
const MINUTE = 60_000;

function editorSession(overrides = {}) {
  return createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Rules' }),
    onEditorHold: async () => {},
    onEditorUpdate: async () => {},
    ...overrides,
  });
}

test('an open editor has no timer: every contact restarts the 14-minute idle window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const token = editorSession();
  try {
    assert.equal((await applyEmbedColorPickerSession(token, open('p'), page('p'))).ok, true);
    // Working for 40 minutes: a heartbeat or an edit keeps arriving.
    for (let minute = 0; minute < 40; minute += 10) {
      t.mock.timers.tick(10 * MINUTE);
      const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('p'));
      assert.equal(heartbeat.ok, true, `still open after ${minute + 10} minutes`);
    }
    const edit = '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({ field: 'title', value: 'Still working' });
    assert.equal((await applyEmbedColorPickerSession(token, edit, page('p'))).ok, true);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('14 minutes without any contact from the page (closed or asleep) ends the editor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const token = editorSession();
  try {
    assert.equal((await applyEmbedColorPickerSession(token, open('p'), page('p'))).ok, true);
    t.mock.timers.tick(EMBED_EDITOR_IDLE_MS - 1);
    assert.equal((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('p'))).ok, true);
    t.mock.timers.tick(EMBED_EDITOR_IDLE_MS);
    const late = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('p'));
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'editor_expired');
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('the editor page gets the exact Builder preview and knows when Discord paused its own preview', async () => {
  let paused = false;
  const preview = { title: 'Rules', description: 'Be kind.', color: 0x8E44AD, image: { url: 'attachment://banner.png' } };
  const token = editorSession({
    getPreviewEmbed: () => preview,
    isPreviewPaused: () => paused,
    getPreviewMedia: () => ({ buffer: Buffer.from('png'), name: 'banner.png' }),
  });
  try {
    await applyEmbedColorPickerSession(token, open('p'), page('p'));
    const state = JSON.parse((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__', page('p'))).color);
    assert.deepEqual(state.preview, preview);
    assert.equal(state.discordPreviewPaused, false);
    paused = true;
    const heartbeat = JSON.parse((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__', page('p'))).color);
    assert.equal(heartbeat.discordPreviewPaused, true);
    const fresh = JSON.parse((await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_PREVIEW__', page('p'))).color);
    assert.equal(fresh.type, 'editor_preview');
    assert.deepEqual(fresh.preview, preview);
    assert.equal(getEmbedEditorMedia(token).name, 'banner.png');
    assert.equal(getEmbedEditorMedia('unknown-token'), null);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});
