import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTransientMessageDeletion, scheduleTransientInteractionReplyDeletion } from '../src/utils/transientResponse.js';
import dedicatedChannelsMessageCreate from '../src/events/dedicatedChannelsMessageCreate.js';

function statusMessage(id, deletes) {
  return {
    id, guildId: 'g', channelId: 'c', client: { user: { id: 'bot' } }, author: { id: 'bot', bot: true },
    guild: { id: 'g', channels: { cache: { find: () => null, filter: () => [] } } },
    channel: { name: 'general' }, embeds: [{ title: 'Wrong channel', description: 'Use #gambling.' }],
    components: [], deletable: true, delete: async () => { deletes.push(id); },
  };
}

test('a public status notice gets one 10-second delete, even when two listeners schedule it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deletes = [];
  const message = statusMessage('1300000000000000301', deletes);
  assert.equal(scheduleTransientMessageDeletion(message), true);
  // A second listener (or a repeated event) for the same message adds no timer.
  dedicatedChannelsMessageCreate.execute(message);
  assert.equal(scheduleTransientMessageDeletion(message), false);
  t.mock.timers.tick(9_999);
  assert.deepEqual(deletes, []);
  t.mock.timers.tick(1);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.deepEqual(deletes, [message.id]);
  // Once that timer has fired, the ID can be scheduled again (e.g. after an edit).
  assert.equal(scheduleTransientMessageDeletion(message), true);
});

test('the post-command check does not fetch the reply again when its 10-second timer already exists', async () => {
  let fetches = 0;
  const interaction = { replied: true, __cloudyTransientReplyScheduled: true,
    fetchReply: async () => { fetches += 1; return { embeds: [{ title: 'Success' }], channel: { name: 'general' } }; },
    deleteReply: async () => {} };
  assert.equal(await scheduleTransientInteractionReplyDeletion(interaction), false);
  assert.equal(fetches, 0);
});
