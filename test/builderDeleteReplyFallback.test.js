import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { deleteLifecycleMessage } from '../src/utils/interactionMessageLifecycle.js';

function builderMessage() {
  return {
    id: 'builder-original',
    flags: { has: flag => flag === MessageFlags.Ephemeral },
    embeds: [
      { title: 'Preview' },
      { title: 'Message builder' },
    ],
    components: [{ components: [{ customId: 'simple_embed_post' }] }],
  };
}

test('failed cleanup of a secondary response never falls through to deleteReply on the Builder', async () => {
  let deleteReplyCalls = 0;
  const secondary = {
    id: 'secondary-status',
    embeds: [{ title: 'Status' }],
    components: [],
    delete: async () => { throw new Error('not a channel message'); },
  };
  const interaction = {
    webhook: { deleteMessage: async () => { throw new Error('unknown message'); } },
    fetchReply: async () => builderMessage(),
    deleteReply: async () => { deleteReplyCalls += 1; },
  };

  assert.equal(await deleteLifecycleMessage(secondary, interaction), false);
  assert.equal(deleteReplyCalls, 0);
});

test('deleteReply fallback still works when the target really is the original non-Builder reply', async () => {
  let deleteReplyCalls = 0;
  const original = {
    id: 'normal-original',
    embeds: [{ title: 'Normal dashboard' }],
    components: [],
    delete: async () => { throw new Error('not a channel message'); },
  };
  const interaction = {
    webhook: { deleteMessage: async () => { throw new Error('webhook unavailable'); } },
    fetchReply: async () => original,
    deleteReply: async () => { deleteReplyCalls += 1; },
  };

  assert.equal(await deleteLifecycleMessage(original, interaction), true);
  assert.equal(deleteReplyCalls, 1);
});
