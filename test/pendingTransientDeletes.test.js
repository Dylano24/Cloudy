import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { installInteractionMessageLifecycle } from '../src/utils/interactionMessageLifecycle.js';
import { flushPendingDeletes, pendingDeleteCount, registerPendingDelete } from '../src/utils/pendingTransientDeletes.js';

test('a restart removes 10-second replies at once instead of leaving them behind', async () => {
  installInteractionMessageLifecycle();
  const deleted = [];
  const message = { id: 'notice-1', flags: { has: flag => flag === MessageFlags.Ephemeral }, embeds: [{ title: 'Success', description: 'The vote is live.' }], components: [] };
  const interaction = {
    id: 'i-1', commandName: 'vote', deferred: true, replied: false,
    webhook: { deleteMessage: async id => { deleted.push(id); } },
    editReply: async () => message, fetchReply: async () => message,
  };
  InteractionHelper.patchInteractionResponses(interaction);
  await interaction.editReply({ embeds: [{ title: 'Success', description: 'The vote is live.' }] });
  assert.ok(pendingDeleteCount() >= 1);
  const flushed = await flushPendingDeletes(1_000);
  assert.ok(flushed >= 1);
  assert.deepEqual(deleted, ['notice-1']);
  assert.equal(pendingDeleteCount(), 0);
});

test('a stuck removal does not hold up the shutdown', async () => {
  registerPendingDelete('stuck', () => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await flushPendingDeletes(50), 1);
  assert.ok(Date.now() - started < 1_000);
});
