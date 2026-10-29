import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EMBED_EDITOR_IDLE_MS,
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
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

test('a paused Discord preview no longer ends the editor; only an ended Builder does', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const mark = source.slice(source.indexOf('function markBuilderPreviewUnavailable'), source.indexOf('// BUILDER_SINGLE_PREVIEW_TARGET_V1'));
  assert.match(mark, /state\.builderPreviewUnavailable = true/);
  assert.doesNotMatch(mark, /deleteEmbedColorPickerSession/);
  const hold = source.slice(source.indexOf('onEditorHold: async () => {'), source.indexOf('onEditorUpdate: async'));
  assert.match(hold, /if \(!state\.builderDashboardMessage\)/);
  assert.doesNotMatch(hold, /builderPreviewUnavailable \|\|/);
  assert.match(source, /collector\.on\('end'[\s\S]*deleteEmbedColorPickerSession\(colorSessionToken\)/);
});

test('the editor page looks exactly as before: no extra preview block or styles', async () => {
  const { embedColorPickerPage } = await import('../src/web/embedColorPickerPage.js');
  const html = embedColorPickerPage();
  assert.doesNotMatch(html, /previewSection|dc-embed|CLOUDY_EDITOR_OWN_PREVIEW/);
  assert.match(html, /<h1 id="editorTitle">Edit title and message<\/h1>/);
});
