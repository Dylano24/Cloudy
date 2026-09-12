import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  applyEmbedColorPickerSession as apply,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';
import { deleteBuilderSessionMessage, touchBuilderSessionMessage } from '../src/utils/builderSessionCleanup.js';

const minute = 60_000;
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function fixture(t, deferred = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  let entered;
  const gate = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  let deleted = 0;
  const message = {
    id: t.name,
    embeds: [{ title: 'Message builder' }],
    delete: async () => { deleted += 1; },
  };
  const token = createEmbedColorPickerSession({
    userId: 'test', onColor: async () => {}, getEditorState: () => ({}),
    onEditorUpdate: async () => {},
    onEditorHold: async () => {
      calls += 1;
      touchBuilderSessionMessage(message);
      entered();
      if (deferred && calls === 1) await gate;
    },
  });
  t.after(async () => {
    deleteEmbedColorPickerSession(token);
    await deleteBuilderSessionMessage(message);
  });
  const send = (value, sequence, id = 'page') => apply(token, value, {
    editorInstanceId: id, editorPresenceSequence: sequence,
  });
  return { send, finish, started, deleted: () => deleted };
}

test('resume after PAUSE during hold acquisition protects the actual Builder past five minutes', async t => {
  const f = fixture(t, true);
  const opening = f.send('__CLOUDY_EMBED_OPEN__:page', 1);
  await f.started;
  await f.send('__CLOUDY_EMBED_PAUSE__', 2);
  f.finish();
  await opening;
  await f.send('__CLOUDY_EMBED_HEARTBEAT__', 3);
  t.mock.timers.tick(6 * minute);
  await settle();
  assert.equal(f.deleted(), 0);
});

test('late PAUSE cannot undo a newer resume and resume does not extend fourteen minutes', async t => {
  const f = fixture(t);
  await f.send('__CLOUDY_EMBED_OPEN__:page', 1);
  t.mock.timers.tick(2 * minute);
  await f.send('__CLOUDY_EMBED_PAUSE__', 2);
  t.mock.timers.tick(2 * minute);
  await f.send('__CLOUDY_EMBED_HEARTBEAT__', 3);
  await f.send('__CLOUDY_EMBED_PAUSE__', 2);
  t.mock.timers.tick(6 * minute);
  await settle();
  assert.equal(f.deleted(), 0);
  t.mock.timers.tick(4 * minute);
  assert.equal((await f.send('__CLOUDY_EMBED_HEARTBEAT__', 4)).ok, false);
  t.mock.timers.tick(5 * minute);
  await settle();
  assert.equal(f.deleted(), 1);
});

test('late heartbeat cannot reacquire a paused Builder and postpone its normal five minutes', async t => {
  const f = fixture(t);
  await f.send('__CLOUDY_EMBED_OPEN__:page', 1);
  await f.send('__CLOUDY_EMBED_PAUSE__', 3);
  await f.send('__CLOUDY_EMBED_HEARTBEAT__', 2);
  t.mock.timers.tick(5 * minute);
  await settle();
  assert.equal(f.deleted(), 1);
});

test('lease expiry during hold acquisition cannot leave an immortal Builder hold', async t => {
  const f = fixture(t, true);
  const opening = f.send('__CLOUDY_EMBED_OPEN__:page', 1);
  await f.started;
  t.mock.timers.tick(14 * minute);
  f.finish();
  await opening;
  assert.equal((await f.send('__CLOUDY_EMBED_HEARTBEAT__', 2)).ok, false);
  t.mock.timers.tick(5 * minute);
  await settle();
  assert.equal(f.deleted(), 1);
});

test('cached-page pageshow resumes the same page with ordered events and no new OPEN', async () => {
  const source = fs.readFileSync('src/web/embedColorPickerPage.js', 'utf8');
  const start = source.indexOf('    const params =');
  const end = source.indexOf("    if (mode === 'content'", start);
  const requests = [];
  const handlers = new Map();
  const document = { visibilityState: 'visible', addEventListener() {} };
  vm.runInNewContext(source.slice(start, end), {
    URLSearchParams, location: { search: '?session=test' }, document,
    setInterval: () => 1,
    window: { addEventListener: (name, handler) => handlers.set(name, handler) },
    navigator: {},
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ color: '{}' }) };
    },
  });
  await settle();
  handlers.get('pagehide')();
  await settle();
  assert.equal(typeof handlers.get('pageshow'), 'function');
  handlers.get('pageshow')();
  await settle();
  handlers.get('pagehide')();
  await settle();
  assert.equal(requests.filter(r => r.color.startsWith('__CLOUDY_EMBED_OPEN__:')).length, 1);
  assert.equal(requests.filter(r => r.color === '__CLOUDY_EMBED_PAUSE__').length, 2);
  assert.equal(requests.at(-2).color, '__CLOUDY_EMBED_HEARTBEAT__');
  assert.equal(new Set(requests.map(r => r.editorInstanceId)).size, 1);
  assert.deepEqual(requests.map(r => r.editorPresenceSequence), requests.map((_, i) => i + 1));
});
