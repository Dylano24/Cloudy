import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDER_SESSION_IDLE_MS,
  deleteBuilderSessionMessage,
  isBuilderSessionMessage,
  linkBuilderSessionMessages,
  registerBuilderSessionCollector,
  shouldDeleteBuilderSessionOnCollectorEnd,
  touchBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';

test('builder inactivity timeout is exactly one minute', () => {
  assert.equal(BUILDER_SESSION_IDLE_MS, 60_000);
});

test('session cleanup only targets Message Builder and Modify Embed messages', () => {
  assert.equal(isBuilderSessionMessage({
    id: '1',
    embeds: [{ title: 'Preview' }, { title: 'Message builder' }],
  }), true);

  assert.equal(isBuilderSessionMessage({
    id: '2',
    embeds: [{ title: 'Modify embed' }],
  }), true);

  assert.equal(isBuilderSessionMessage({
    id: '3',
    embeds: [{ title: 'Changes saved' }],
  }), false);
});

test('Modify Embed is deleted when the parent builder ends from inactivity', () => {
  assert.equal(shouldDeleteBuilderSessionOnCollectorEnd('idle'), true);
  assert.equal(shouldDeleteBuilderSessionOnCollectorEnd('builder-ended'), true);
  assert.equal(shouldDeleteBuilderSessionOnCollectorEnd('posted'), false);
  assert.equal(shouldDeleteBuilderSessionOnCollectorEnd('replaced'), false);
});

test('builder cleanup deletes ephemeral messages through the interaction webhook', async () => {
  let webhookDeletes = 0;
  let directDeletes = 0;
  const message = {
    id: 'builder-session-message',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {
      directDeletes += 1;
      throw new Error('ephemeral messages cannot be deleted as normal channel messages');
    },
  };

  const touched = touchBuilderSessionMessage(message, async () => {
    webhookDeletes += 1;
  });

  assert.equal(touched, true);
  assert.equal(await deleteBuilderSessionMessage(message), true);
  assert.equal(webhookDeletes, 1);
  assert.equal(directDeletes, 0);
});

test('Modify Embed activity resets both its own and the parent Message Builder idle collector', async () => {
  let parentResets = 0;
  let managerResets = 0;
  const parent = {
    id: 'parent-builder-session',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {},
  };
  const manager = {
    id: 'modify-manager-session',
    embeds: [{ title: 'Modify embed' }],
    delete: async () => {},
  };
  const parentCollector = {
    ended: false,
    resetTimer(options) {
      assert.equal(options.idle, BUILDER_SESSION_IDLE_MS);
      parentResets += 1;
    },
  };
  const managerCollector = {
    ended: false,
    resetTimer(options) {
      assert.equal(options.idle, BUILDER_SESSION_IDLE_MS);
      managerResets += 1;
    },
  };

  assert.equal(registerBuilderSessionCollector(parent, parentCollector), true);
  assert.equal(registerBuilderSessionCollector(manager, managerCollector), true);
  assert.equal(linkBuilderSessionMessages(parent, manager), true);

  touchBuilderSessionMessage(manager);

  assert.equal(managerResets, 1);
  assert.equal(parentResets, 1);

  await deleteBuilderSessionMessage(manager);
  await deleteBuilderSessionMessage(parent);
});

test('live Message Builder refresh activity resets its collector', async () => {
  let resets = 0;
  const parent = {
    id: 'live-builder-session',
    embeds: [{ title: 'Message builder' }],
    delete: async () => {},
  };
  const collector = {
    ended: false,
    resetTimer(options) {
      assert.equal(options.idle, BUILDER_SESSION_IDLE_MS);
      resets += 1;
    },
  };

  assert.equal(registerBuilderSessionCollector(parent, collector), true);
  touchBuilderSessionMessage(parent);
  touchBuilderSessionMessage(parent);

  assert.equal(resets, 2);
  await deleteBuilderSessionMessage(parent);
});
