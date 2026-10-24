import assert from 'node:assert/strict';
import test from 'node:test';
import { db } from '../src/utils/database.js';

import {
  FAQ_AI_BUTTON_ID,
  FAQ_AI_CHANNEL_ID,
  reconcileFaqAiPanel,
  isFaqPanelComponentContractSafe,
  isFaqAiPanelMessage,
} from '../src/services/faqAiService.js';

function messageWith(...customIds) {
  return {
    author: { id: 'cloudy-bot' },
    components: customIds.map(customId => ({
      components: [{ customId }],
    })),
  };
}

test('FAQ panel component contract accepts only the FAQ question action', () => {
  assert.equal(
    isFaqPanelComponentContractSafe(messageWith(FAQ_AI_BUTTON_ID), 'cloudy-bot'),
    true,
  );
});

test('FAQ panel component contract rejects a ticket action mixed into the FAQ panel', () => {
  assert.equal(
    isFaqPanelComponentContractSafe(
      messageWith(FAQ_AI_BUTTON_ID, 'create_ticket'),
      'cloudy-bot',
    ),
    false,
  );
});

test('FAQ panel component contract rejects a mislabeled/non-FAQ action even if it is the only button', () => {
  assert.equal(
    isFaqPanelComponentContractSafe(messageWith('create_ticket'), 'cloudy-bot'),
    false,
  );
});

test('a saved FAQ panel ID cannot cause an unrelated bot ticket or log message to be edited', () => {
  const unrelatedBotMessage = {
    author: { id: 'cloudy-bot' },
    embeds: [{ title: 'Ticket created', description: 'Ticket details' }],
    components: [{ components: [{ customId: 'create_ticket' }] }],
  };

  assert.equal(isFaqAiPanelMessage(unrelatedBotMessage, 'cloudy-bot'), false);
  assert.equal(isFaqAiPanelMessage(
    { ...unrelatedBotMessage, embeds: [{ title: 'Cloudy Support Assistant' }] },
    'cloudy-bot',
  ), true);
  assert.equal(isFaqAiPanelMessage(
    { ...unrelatedBotMessage, components: [{ components: [{ customId: FAQ_AI_BUTTON_ID }] }] },
    'cloudy-bot',
  ), true);
  assert.equal(isFaqAiPanelMessage(
    { ...unrelatedBotMessage, author: { id: 'another-user' } },
    'cloudy-bot',
  ), false);
});

test('FAQ reconciliation must not repair unrelated saved bot messages', async t => {
  t.mock.method(db, 'get', async () => []);
  t.mock.method(db, 'set', async () => true);

  let unrelatedEdits = 0;
  let newFaqPosts = 0;
  const unrelated = {
    id: 'unrelated-saved-id',
    author: { id: 'cloudy-bot' },
    embeds: [{ title: 'Ticket created' }],
    components: [{ components: [{ customId: 'create_ticket' }] }],
    async edit() { unrelatedEdits += 1; return this; },
  };
  const channel = {
    id: FAQ_AI_CHANNEL_ID,
    isTextBased: () => true,
    isThread: () => false,
    messages: {
      fetch: async query => typeof query === 'string'
        ? unrelated
        : { find: () => null },
    },
    async send(payload) {
      newFaqPosts += 1;
      return {
        id: 'new-faq-id',
        guildId: 'faq-test-guild',
        channelId: FAQ_AI_CHANNEL_ID,
        channel: this,
        author: { id: 'cloudy-bot' },
        client,
        createdAt: new Date(),
        content: '',
        ...payload,
      };
    },
  };
  const client = {
    user: { id: 'cloudy-bot' },
    channels: { cache: new Map([[FAQ_AI_CHANNEL_ID, channel]]) },
    db: { get: async () => 'unrelated-saved-id', set: async () => true },
  };

  await reconcileFaqAiPanel(client);

  assert.equal(unrelatedEdits, 0, 'never replace ticket/log buttons with FAQ components');
  assert.equal(newFaqPosts, 1, 'create a new FAQ panel when the saved ID is unrelated');
  assert.deepEqual(unrelated.components, [{ components: [{ customId: 'create_ticket' }] }]);
});
