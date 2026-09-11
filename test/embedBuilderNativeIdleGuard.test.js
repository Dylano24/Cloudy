import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerBuilderSessionCollector,
  deleteBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('registering a Builder collector removes any native discord.js idle timer', async () => {
  let nativeIdleFired = false;
  const nativeIdleTimer = setTimeout(() => {
    nativeIdleFired = true;
  }, 40);

  const message = {
    id: 'native-idle-builder',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {},
  };

  const collector = {
    ended: false,
    options: { idle: 5 * 60_000 },
    _idletimeout: nativeIdleTimer,
    resetTimer() {},
    stop() {
      this.ended = true;
    },
  };

  assert.equal(registerBuilderSessionCollector(message, collector), true);
  assert.equal(collector._idletimeout, null);
  assert.equal('idle' in collector.options, false);

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(nativeIdleFired, false);

  await deleteBuilderSessionMessage(message);
});
