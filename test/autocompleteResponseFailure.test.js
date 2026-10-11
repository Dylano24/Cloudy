import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../src/events/interactionCreate.js';
import { logger } from '../src/utils/logger.js';

test('expired autocomplete response is contained rather than escaping to the router error handler', async t => {
  const errors = [];
  t.mock.method(logger, 'error', (message, ...args) => { errors.push([message, ...args]); });
  await router.execute({ commandName: 'reactroles', guildId: '975000000000000001', guild: {}, user: { id: '975000000000000002' },
    isChatInputCommand: () => false, isMessageContextMenuCommand: () => false, isAutocomplete: () => true,
    options: { getFocused: () => ({ name: 'panel', value: '' }) },
    respond: async () => { throw new Error('expired interaction'); },
  }, { commands: new Map(), db: { list: async () => { throw new Error('offline'); } } });
  assert.equal(errors.some(([message]) => message === 'Unhandled error in interactionCreate:'), false);
});
