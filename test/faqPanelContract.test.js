import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAQ_AI_BUTTON_ID,
  isFaqPanelComponentContractSafe,
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
