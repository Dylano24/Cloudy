import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAQ_RESPONSE_DELETE_DELAY_MS,
  editFaqOriginalReply,
  scheduleEphemeralDeletion,
} from '../src/events/faqAiInteraction.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('FAQ AI answer bypasses wrapped interaction.editReply and edits the deferred original directly', async () => {
  const edits = [];
  const interaction = {
    webhook: {
      editMessage: async (messageId, payload) => {
        edits.push({ messageId, payload });
        return { id: 'faq-reply' };
      },
    },
    editReply: async () => assert.fail('FAQ AI must not pass its dynamic answer through response templates'),
  };

  const payload = {
    embeds: [{ title: 'Cloudy Support Assistant', description: 'The real AI answer.' }],
  };
  const result = await editFaqOriginalReply(interaction, payload);

  assert.equal(result.id, 'faq-reply');
  assert.deepEqual(edits, [{ messageId: '@original', payload }]);
});

test('FAQ AI replies are removed after exactly 10 seconds through the interaction webhook', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deletions = [];
  const interaction = {
    webhook: {
      deleteMessage: async messageId => {
        deletions.push(messageId);
      },
    },
    deleteReply: async () => assert.fail('Webhook deletion should be preferred'),
  };

  assert.equal(FAQ_RESPONSE_DELETE_DELAY_MS, 10_000);
  scheduleEphemeralDeletion(interaction);

  t.mock.timers.tick(9_999);
  await settle();
  assert.deepEqual(deletions, []);

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(deletions, ['@original']);
});
