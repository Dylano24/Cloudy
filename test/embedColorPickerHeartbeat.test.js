import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMBED_EDITOR_IDLE_MS,
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

test('web editor inactivity timeout is exactly fourteen minutes', () => {
  assert.equal(EMBED_EDITOR_IDLE_MS, 14 * 60_000);
});

test('web editor heartbeat establishes its builder hold once without changing content state', async () => {
  const contentUpdates = [];
  const holds = [];

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorHold: async () => {
      holds.push('hold');
    },
    onEditorUpdate: async field => {
      contentUpdates.push(field);
    },
  });

  try {
    const first = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    const second = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(holds, ['hold']);
    assert.deepEqual(contentUpdates, []);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('concurrent editor bootstrap requests share one hold refresh', async () => {
  let holds = 0;
  let releaseHold;
  const holdGate = new Promise(resolve => {
    releaseHold = resolve;
  });

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title' }),
    onEditorHold: async () => {
      holds += 1;
      await holdGate;
    },
    onEditorUpdate: async () => {},
  });

  try {
    const heartbeatPromise = applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    const statePromise = applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    const activityPromise = applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_ACTIVITY__');

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(holds, 1);
    releaseHold();

    const [heartbeat, state, activity] = await Promise.all([
      heartbeatPromise,
      statePromise,
      activityPromise,
    ]);
    assert.equal(heartbeat.ok, true);
    assert.equal(state.ok, true);
    assert.equal(activity.ok, true);
    assert.equal(JSON.parse(activity.color).type, 'activity');
    assert.equal(holds, 1);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('closing and reopening editor refreshes the same session instead of expiring it', async () => {
  const contentUpdates = [];
  const holds = [];
  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Still here' }),
    onEditorHold: async () => {
      holds.push('hold');
    },
    onEditorUpdate: async field => {
      contentUpdates.push(field);
    },
  });

  try {
    const heartbeat = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_HEARTBEAT__',
      { editorInstanceId: 'page-before-close' },
    );
    assert.equal(heartbeat.ok, true);

    const closed = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_CLOSE__',
      { editorInstanceId: 'page-before-close' },
    );
    assert.equal(closed.ok, true);
    assert.equal(JSON.parse(closed.color).type, 'editor_closed');

    const reopened = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_ACTIVITY__',
      { editorInstanceId: 'page-after-reopen' },
    );
    assert.equal(reopened.ok, true);

    const stateResult = await applyEmbedColorPickerSession(
      token,
      '__CLOUDY_EMBED_STATE__',
      { editorInstanceId: 'page-after-reopen' },
    );
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still here');
    assert.deepEqual(holds, ['hold', 'hold']);
    assert.deepEqual(contentUpdates, []);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('loading editor state does not create a phantom content update after the hold handshake', async () => {
  const contentUpdates = [];
  const holds = [];

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: async () => {},
    getEditorState: () => ({ title: 'Existing title', message: 'Existing message' }),
    onEditorHold: async () => {
      holds.push('hold');
    },
    onEditorUpdate: async field => {
      contentUpdates.push(field);
    },
  });

  try {
    const result = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(result.ok, true);
    assert.deepEqual(holds, ['hold']);
    assert.deepEqual(contentUpdates, []);
    const state = JSON.parse(result.color);
    assert.equal(state.title, 'Existing title');
    assert.equal(state.message, 'Existing message');
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});

test('expired Discord preview does not expire the open web editor session', async () => {
  let currentTitle = 'Existing title';
  let previewAvailable = true;

  const previewRefresh = async () => {
    if (!previewAvailable) {
      const error = new Error('The message builder session has expired.');
      error.code = 'EMBED_BUILDER_EXPIRED';
      throw error;
    }
  };

  const token = createEmbedColorPickerSession({
    userId: '1',
    onColor: previewRefresh,
    getEditorState: () => ({ title: currentTitle }),
    onEditorHold: previewRefresh,
    onEditorUpdate: async (field, value) => {
      if (field === 'title') currentTitle = value;
      await previewRefresh();
    },
  });

  try {
    const heartbeat = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(heartbeat.ok, true);

    previewAvailable = false;

    const closed = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_CLOSE__');
    assert.equal(closed.ok, true);

    const reopened = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_ACTIVITY__');
    assert.equal(reopened.ok, true);

    const editPayload = '__CLOUDY_EMBED_EDIT__:' + JSON.stringify({
      field: 'title',
      value: 'Still saved after preview expiry',
    });
    const edit = await applyEmbedColorPickerSession(token, editPayload);
    assert.equal(edit.ok, true);

    await new Promise(resolve => { setTimeout(resolve, 5); });

    const stateResult = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_STATE__');
    assert.equal(stateResult.ok, true);
    assert.equal(JSON.parse(stateResult.color).title, 'Still saved after preview expiry');

    const color = await applyEmbedColorPickerSession(token, '#123456');
    assert.equal(color.ok, true);

    const heartbeatAfterExpiry = await applyEmbedColorPickerSession(token, '__CLOUDY_EMBED_HEARTBEAT__');
    assert.equal(heartbeatAfterExpiry.ok, true);
  } finally {
    deleteEmbedColorPickerSession(token);
  }
});
