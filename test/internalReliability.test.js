import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../src/utils/memoryStorage.js';
import { Mutex } from '../src/utils/mutex.js';
import { cleanMainTicketMessage } from '../src/events/ticketLegacyLogoCleanup.js';

const sleep = ms => new Promise(resolve => {
  setTimeout(resolve, ms);
});

test('MemoryStorage clears an old TTL when a key is overwritten without TTL', async () => {
  const storage = new MemoryStorage();

  await storage.set('session', 'temporary', 0.01);
  await storage.set('session', 'persistent');
  await sleep(20);

  assert.equal(await storage.get('session'), 'persistent');
  assert.equal(await storage.exists('session'), true);
});

test('Mutex.runExclusiveMany serializes overlapping key sets without deadlock', async () => {
  let active = 0;
  let maxActive = 0;
  const execution = [];

  const run = (name, keys) => Mutex.runExclusiveMany(keys, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    execution.push(`${name}:start`);
    await sleep(15);
    execution.push(`${name}:end`);
    active -= 1;
  });

  await Promise.all([
    run('first', ['economy:guild:user-a', 'economy:guild:user-b']),
    run('second', ['economy:guild:user-b', 'economy:guild:user-a']),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(execution, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);
});

test('cleanMainTicketMessage safely ignores messages without embeds', async () => {
  const message = {
    embeds: [],
    attachments: new Map(),
    content: '',
    edit: async () => {
      throw new Error('edit should not be called when there are no embeds');
    },
  };

  const result = await cleanMainTicketMessage(message);

  assert.equal(result, false);
});
