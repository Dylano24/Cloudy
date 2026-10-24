import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAQ_AI_BUTTON_ID,
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
