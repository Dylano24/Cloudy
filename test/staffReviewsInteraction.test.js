import test from 'node:test';
import assert from 'node:assert/strict';

import staffReviewsInteraction from '../src/events/staffReviewsInteraction.js';
import {
  STAFF_REVIEW_MEMBER_ID,
  STAFF_REVIEW_MODAL_ID,
  STAFF_REVIEW_RATING_ID,
  STAFF_REVIEW_STAR_EMOJI_ID,
  STAFF_REVIEW_STAR_EMOJI_NAME,
  buildPublishedReview,
  buildStaffReviewsPanel,
  createReviewContext,
  ensureStaffReviewStarEmoji,
  takeReviewContext,
} from '../src/services/staffReviewsService.js';

test('rating choices show one through five white stars without text', () => {
  const panel = buildStaffReviewsPanel([]);
  const ratingOptions = panel.components[1].components[0].toJSON().options;

  assert.deepEqual(ratingOptions.map(option => option.label), [
    '★',
    '★★',
    '★★★',
    '★★★★',
    '★★★★★',
  ]);
  assert.ok(ratingOptions.every(option => option.emoji === undefined));
});

function buildGuild({ cachedHasOwner = false, freshHasOwner }) {
  const ownerRole = { id: 'owner-role-id', name: 'Owner' };
  const buildMember = hasOwner => ({
    id: 'owner-member-id',
    user: { bot: false },
    roles: {
      cache: {
        has: roleId => roleId === ownerRole.id && hasOwner,
      },
    },
  });
  const cachedMember = buildMember(cachedHasOwner);
  const freshMember = buildMember(freshHasOwner);

  return {
    roles: {
      cache: {
        find: predicate => (predicate(ownerRole) ? ownerRole : null),
      },
    },
    members: {
      fetch: async options => {
        const memberId = typeof options === 'string' ? options : options?.user;
        if (memberId !== freshMember.id) return null;
        return options?.force ? freshMember : cachedMember;
      },
      cache: new Map([[cachedMember.id, cachedMember]]),
    },
  };
}

test('staff review is not published when deferReply rejects', async () => {
  let channelFetches = 0;
  const user = { id: 'defer-failure-user' };
  const reviewId = createReviewContext(user.id, 'owner-member-id', 5);

  const interaction = {
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: `${STAFF_REVIEW_MODAL_ID}:${reviewId}`,
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

test('staff review choices are user-private with both original dropdowns and no new message', async () => {
  const publicPanel = buildStaffReviewsPanel([{ id: 'owner-member-id', displayName: 'Lano',
    user: { username: 'Lano' } }]);
  let publicEdits = 0;
  const message = { ...publicPanel, edit: async () => { publicEdits += 1; } };
  let acknowledgements = 0;
  for (const userId of ['private-reviewer-1', 'private-reviewer-2']) {
    await staffReviewsInteraction.execute({
      customId: STAFF_REVIEW_MEMBER_ID,
      guildId: 'private-test-guild',
      user: { id: userId },
      values: ['owner-member-id'],
      message,
      isStringSelectMenu: () => true,
      reply: async () => { throw new Error('No second private rating dropdown allowed'); },
      deferUpdate: async () => { acknowledgements += 1; },
    });
  }
  assert.equal(publicEdits, 0);
  assert.equal(acknowledgements, 2);
  assert.equal(message.components[1].toJSON().components[0].disabled, false);
  assert.notEqual(message.components[0].toJSON().components[0].options[0].default, true);
});

test('two staff reviewers can choose different members on the same public dropdowns', async () => {
  const ownerRole = { id: 'role-owner', name: 'Owner' };
  const ownerIds = ['111111111111111111', '222222222222222222'];
  const members = new Map(ownerIds.map(id => [id, {
    id, user: { bot: false },
    roles: { cache: { has: roleId => roleId === ownerRole.id } },
  }]));
  const guild = {
    roles: { cache: { find: predicate => predicate(ownerRole) ? ownerRole : null } },
    members: { fetch: async ({ user }) => members.get(user) || null },
  };
  const panel = buildStaffReviewsPanel(ownerIds.map(id => ({
    id, displayName: id, user: { username: id },
  })));
  let edits = 0;
  const message = { components: panel.components, async edit() { edits += 1; } };
  const users = ['staff-reviewer-first', 'staff-reviewer-second'];
  for (let i = 0; i < 2; i++) {
    await staffReviewsInteraction.execute({
      customId: STAFF_REVIEW_MEMBER_ID,
      guildId: 'private-test-guild', user: { id: users[i] }, guild, message,
      values: [ownerIds[i]], isStringSelectMenu: () => true,
      deferUpdate: async () => {},
      reply: async () => { throw new Error('Never send separate rating panels'); },
    });
  }
  const modals = [];
  for (let i = 0; i < 2; i++) {
    await staffReviewsInteraction.execute({
      customId: STAFF_REVIEW_RATING_ID,
      guildId: 'private-test-guild', user: { id: users[i] }, guild, message,
      values: ['5'], isStringSelectMenu: () => true,
      showModal: async modal => { modals.push(modal.toJSON().custom_id); },
    });
  }
  assert.deepEqual(modals, ownerIds.map(id => `staff_review_modal:${id}:5`));
  assert.equal(edits, 0, 'neither selection may edit the public review panel');
  assert.equal(message.components[1].toJSON().components[0].disabled, false);
});

test('rating selection rejects stale cached Owner membership', async () => {
  let replyContent = null;
  let modalShown = false;

  const interaction = {
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
    customId: `${STAFF_REVIEW_RATING_ID}:owner-member-id`,
    values: ['5'],
    user: { id: 'lost-owner-rating-user' },
    guild: buildGuild({ cachedHasOwner: true, freshHasOwner: false }),
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

test('modal submission revalidates fresh Owner membership before publishing', async () => {
  let channelFetches = 0;
  let editReplyContent = null;
  const user = { id: 'lost-owner-modal-user' };
  const reviewId = createReviewContext(user.id, 'owner-member-id', 4);

  const interaction = {
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: `${STAFF_REVIEW_MODAL_ID}:${reviewId}`,
    user,
    guild: buildGuild({ cachedHasOwner: true, freshHasOwner: false }),
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

test('two review contexts from one reviewer stay bound to their own modals', () => {
  const userId = 'multi-review-user';
  const firstReviewId = createReviewContext(userId, 'owner-a', 1);
  const secondReviewId = createReviewContext(userId, 'owner-b', 5);

  assert.notEqual(firstReviewId, secondReviewId);
  assert.deepEqual(takeReviewContext(userId, firstReviewId)?.memberId, 'owner-a');
  assert.deepEqual(takeReviewContext(userId, secondReviewId)?.memberId, 'owner-b');
});

test('published staff reviews repeat the live custom emoji for the selected rating', () => {
  const interaction = {
    user: {
      globalName: 'Reviewer',
      username: 'reviewer',
      displayAvatarURL: () => 'https://example.com/avatar.png',
    },
  };

  const reviewStar = '<:W84starwhite:1543289625035022346>';
  const embed = buildPublishedReview(
    interaction,
    3,
    'Great support',
    '123456789012345678',
    reviewStar,
  );
  const description = embed.toJSON().description;

  assert.match(description, new RegExp(`\\*\\*Rating\\*\\*\\n${reviewStar.repeat(3)}\\n`));
});

test('published staff reviews fall back to visible Unicode stars', () => {
  const interaction = {
    user: {
      globalName: 'Reviewer',
      username: 'reviewer',
      displayAvatarURL: () => 'https://example.com/avatar.png',
    },
  };

  const embed = buildPublishedReview(interaction, 2, 'Great support', '123456789012345678');
  assert.match(embed.toJSON().description, /\*\*Rating\*\*\n⭐⭐\n/);
});

test('staff reviews use the exact existing white glowing star', async () => {
  const reviewEmoji = {
    id: STAFF_REVIEW_STAR_EMOJI_ID,
    toString: () => '<:W84starwhite:1543289625035022346>',
  };
  const guild = {
    emojis: {
      cache: new Map([[STAFF_REVIEW_STAR_EMOJI_ID, reviewEmoji]]),
      fetch: async () => reviewEmoji,
    },
  };

  const rendered = await ensureStaffReviewStarEmoji(guild);

  assert.equal(STAFF_REVIEW_STAR_EMOJI_NAME, 'W84starwhite');
  assert.equal(STAFF_REVIEW_STAR_EMOJI_ID, '1543289625035022346');
  assert.equal(rendered, reviewEmoji.toString());
});
