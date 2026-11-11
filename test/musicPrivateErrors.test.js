import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { handleInteractionError, CloudyError, ErrorTypes } from '../src/utils/errorHandler.js';
import { deferMusicPublic } from '../src/services/music/prefixSupport.js';

function fakeInteraction(extra = {}) {
  const calls = [];
  let sent = null;
  const interaction = {
    id: 'music-private-error', createdTimestamp: Date.now(), replied: false, deferred: true, ephemeral: false,
    guildId: 'guild', channelId: 'channel', user: { id: 'user' }, commandName: 'play',
    deleteReply: async () => { calls.push('delete'); },
    editReply: async () => { calls.push('edit'); return { id: 'edited' }; },
    followUp: async payload => { calls.push('followUp'); sent = payload; return { id: 'notice' }; },
    webhook: { deleteMessage: async id => { calls.push('remove:' + id); } },
    ...extra,
  };
  return { interaction, calls, sent: () => sent };
}

test('a failing public music command swaps its public reply for a private notice that removes itself', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { interaction, calls, sent } = fakeInteraction({ __cloudyPrivateErrors: true });
  await handleInteractionError(interaction, new CloudyError('x', ErrorTypes.USER_INPUT, 'Nothing is playing right now.'), { type: 'chatInput' });
  assert.deepEqual(calls, ['delete', 'followUp']);
  assert.equal(sent().flags, MessageFlags.Ephemeral);
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('remove:notice'), 'the private notice is removed after ten seconds');
});

test('other deferred commands keep editing their reply as before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { interaction, calls } = fakeInteraction();
  await handleInteractionError(interaction, new CloudyError('x', ErrorTypes.USER_INPUT, 'Nope.'), { type: 'chatInput' });
  assert.deepEqual(calls, ['edit']);
});

test('a private (ephemeral) reply is never replaced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { interaction, calls } = fakeInteraction({ __cloudyPrivateErrors: true, ephemeral: true });
  await handleInteractionError(interaction, new CloudyError('x', ErrorTypes.USER_INPUT, 'Nope.'), { type: 'chatInput' });
  assert.deepEqual(calls, ['edit']);
});

test('play, queue and now playing answer publicly but keep their problems private', async () => {
  const defers = [];
  const interaction = { id: 'defer-test', user: { id: 'user' }, createdTimestamp: Date.now(), deferred: false, replied: false, deferReply: async options => { defers.push(options); } };
  await deferMusicPublic(interaction);
  assert.equal(interaction.__cloudyPrivateErrors, true);
  assert.deepEqual(defers, [{}], 'the deferred reply itself stays public');
});
