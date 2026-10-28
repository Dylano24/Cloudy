import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPersistentBotMessage,
  isTransientStatusPayload,
  scheduleTransientInteractionReplyDeletion,
} from '../src/utils/transientResponse.js';
import { shouldUseTransientTimer } from '../src/utils/interactionMessageLifecycle.js';

function response({ channelId = '1533188412507558130', name = '🎲｜gambling', title = 'Too fast' } = {}) {
  return {
    id: '1565000000000000000',
    channelId,
    channel: { id: channelId, name },
    embeds: [{
      title,
      description: "You're working too fast! Wait 0h 59m before working again.",
    }],
  };
}

test('Too fast in gambling is a persistent message despite being a status embed', () => {
  const message = response();
  assert.equal(isTransientStatusPayload(null, message), true);
  assert.equal(isPersistentBotMessage(message), true);
  assert.equal(shouldUseTransientTimer({ embeds: message.embeds }, message, { commandName: 'work' }), false);
});

test('command completion must not schedule another ten-second deletion for gambling Too fast', async () => {
  const message = response();
  const interaction = {
    replied: true,
    commandName: 'work',
    fetchReply: async () => message,
    deleteReply: async () => assert.fail('persistent Too fast message deleted'),
  };
  assert.equal(await scheduleTransientInteractionReplyDeletion(interaction), false);
});

test('Too fast outside gambling keeps its usual transient lifetime', () => {
  const message = response({ channelId: '1565000000000000999', name: 'general' });
  assert.equal(isPersistentBotMessage(message), false);
  assert.equal(shouldUseTransientTimer({ embeds: message.embeds }, message, { commandName: 'work' }), true);
});

test('normal work success in gambling is not treated as a Too fast exception', () => {
  const message = response({ title: 'Work complete' });
  assert.equal(isPersistentBotMessage(message), false);
});
