import test from 'node:test';
import assert from 'node:assert/strict';

import staffReviewsInteraction from '../src/events/staffReviewsInteraction.js';
import {
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  rememberRating,
  rememberReviewMember,
} from '../src/services/staffReviewsService.js';

function buildGuild({ memberHasOwner }) {
  const ownerRole = { id: 'owner-role-id', name: 'Owner' };
  const member = {
    id: 'owner-member-id',
    user: { bot: false },
    roles: {
      cache: {
        has: roleId => roleId === ownerRole.id && memberHasOwner,
      },
    },
  };

  return {
    roles: {
      cache: {
        find: predicate => (predicate(ownerRole) ? ownerRole : null),
      },
    },
    members: {
      fetch: async memberId => (memberId === member.id ? member : null),
      cache: new Map([[member.id, member]]),
    },
  };
}

test('staff review is not published when deferReply rejects', async () => {
  let channelFetches = 0;
  const user = { id: 'defer-failure-user' };

  rememberReviewMember(user.id, 'owner-member-id');
  rememberRating(user.id, 5);

  const interaction = {
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: STAFF_REVIEW_MODAL_ID,
    user,
    fields: {
      getTextInputValue: () => 'Great staff',
    },
    deferReply: async () => {
      throw new Error('interaction acknowledgement failed');
    },
    client: {
      channels: {
        fetch: async () => {
          channelFetches += 1;
          return null;
        },
      },
    },
  };

  await staffReviewsInteraction.execute(interaction);

  assert.equal(channelFetches, 0);
});

test('rating selection rejects a member who no longer has Owner', async () => {
  let replyContent = null;
  let modalShown = false;

  const interaction = {
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    customId: `${STAFF_REVIEW_RATING_ID}:owner-member-id`,
    values: ['5'],
    user: { id: 'lost-owner-rating-user' },
    guild: buildGuild({ memberHasOwner: false }),
    reply: async payload => {
      replyContent = payload.content;
    },
    showModal: async () => {
      modalShown = true;
    },
  };

  await staffReviewsInteraction.execute(interaction);

  assert.match(replyContent, /no longer available/i);
  assert.equal(modalShown, false);
});

test('modal submission revalidates Owner before publishing', async () => {
  let channelFetches = 0;
  let editReplyContent = null;
  const user = { id: 'lost-owner-modal-user' };

  rememberReviewMember(user.id, 'owner-member-id');
  rememberRating(user.id, 4);

  const interaction = {
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: STAFF_REVIEW_MODAL_ID,
    user,
    guild: buildGuild({ memberHasOwner: false }),
    fields: {
      getTextInputValue: () => 'Helpful owner',
    },
    deferReply: async () => {},
    editReply: async payload => {
      editReplyContent = payload.content;
    },
    client: {
      channels: {
        fetch: async () => {
          channelFetches += 1;
          return null;
        },
      },
    },
  };

  await staffReviewsInteraction.execute(interaction);

  assert.match(editReplyContent, /no longer available/i);
  assert.equal(channelFetches, 0);
});
