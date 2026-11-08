import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import staffReviewsInteraction from '../src/events/staffReviewsInteraction.js';
import {
  STAFF_REVIEW_MEMBER_ID, STAFF_REVIEW_RATING_ID, STAFF_REVIEWS_CHANNEL_ID,
  buildStaffReviewsPanel,
} from '../src/services/staffReviewsService.js';
import { resolveCloudyChannel } from '../src/services/cloudyChannelResolver.js';

test('staff-posted-reviews receives the review and original dropdowns reset only after posting', async () => {
  const guildId = '1532882647838228723';
  const reviewerId = 'reviewer-publish-reset';
  const memberId = '111111111111111111';
  const postedId = '1777777777777777777';
  const botId = '1534506224312389863';
  const role = { id: 'owner-role-id', name: 'Owner' };
  const owner = { id: memberId, user: { bot: false },
    roles: { cache: { has: id => id === role.id } } };
  const originalEmbed = { title: 'Staff reviews', description: 'Keep this owner-written content' };
  const panel = buildStaffReviewsPanel([{
    id: memberId, displayName: 'Lano', user: { username: 'Lano' },
  }]);
  let panelEdits = 0;
  const message = {
    id: '1788888888888888888', pinned: true, author: { id: botId },
    embeds: [originalEmbed], components: panel.components,
    async edit(payload) {
      assert.deepEqual(Object.keys(payload), ['components'], 'do not modify the embed');
      this.components = payload.components;
      panelEdits += 1;
    },
  };
  const staffChannel = {
    id: STAFF_REVIEWS_CHANNEL_ID, name: '✨│staff-reviews',
    guildId, isTextBased: () => true, isSendable: () => true,
    messages: { async fetchPins() { return { items: [{ message }] }; } },
  };
  const sent = [];
  const postedChannel = {
    id: postedId, name: '⭐│staff-posted-reviews',
    guildId, isTextBased: () => true, isSendable: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: '1999999999999999999', attachments: { size: 0 } };
    },
  };
  const cache = new Collection([
    [staffChannel.id, staffChannel], [postedChannel.id, postedChannel],
  ]);
  const guild = {
    id: guildId,
    channels: { cache, async fetch(id) { return id ? cache.get(id) || null : cache; } },
    roles: { cache: { find: fn => fn(role) ? role : null } },
    members: { async fetch({ user, force }) { return user === memberId && force ? owner : null; } },
  };
  staffChannel.guild = guild;
  postedChannel.guild = guild;
  const client = {
    user: { id: botId }, guilds: { cache: new Collection([[guildId, guild]]) },
    channels: { cache, fetch: async id => cache.get(id) || null },
  };
  const destination = await resolveCloudyChannel(client, 'postedReviews', { guild, textOnly: true });
  assert.equal(destination?.id, postedId, 'resolve the actual staff-posted-reviews channel');

  const user = {
    id: reviewerId, username: 'Reviewer', displayAvatarURL: () => 'https://example.com/a.png',
  };
  await staffReviewsInteraction.execute({
    isStringSelectMenu: () => true, customId: STAFF_REVIEW_MEMBER_ID, guildId, guild, client,
    message, user, values: [memberId],
    deferUpdate: async () => {},
    update: async () => { throw new Error('Member selection must not change shared menu'); },
  });
  assert.equal(message.components[1].toJSON().components[0].disabled, false);
  assert.ok(message.components[0].toJSON().components[0].options.every(option => !option.default));
  assert.equal(panelEdits, 0, 'opening rating does not create an extra public edit');

  let modal;
  await staffReviewsInteraction.execute({
    isStringSelectMenu: () => true, customId: STAFF_REVIEW_RATING_ID, guildId, guild, client,
    message, user, values: ['5'],
    showModal: async value => { modal = value.toJSON(); },
  });
  assert.equal(modal.custom_id, `staff_review_modal:${memberId}:5`);
  assert.equal(message.components[1].toJSON().components[0].disabled, false);

  let result;
  await staffReviewsInteraction.execute({
    isStringSelectMenu: () => false, isModalSubmit: () => true,
    customId: modal.custom_id, guildId, guild, client, user,
    fields: { getTextInputValue: () => 'Excellent support' },
    deferReply: async () => {},
    editReply: async ({ content }) => { result = content; },
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].toJSON().description, /Excellent support/);
  assert.equal(result, 'Your staff review has been published. Thank you!');
  assert.equal(panelEdits, 1, 'reset original panel exactly once after successful posting');
  assert.equal(message.components[1].components[0].disabled, false);
  assert.match(message.components[1].components[0].custom_id,
    /^staff_review_rating:reset:/, 'rotate the rating ID so old stars disappear');
  assert.ok(message.components[0].components[0].options.every(option => !option.default));
  assert.ok(message.components[1].components[0].options.every(option => !option.default));
  assert.deepEqual(message.embeds, [originalEmbed]);

  // A reviewer can use the rotated rating ID without confusing the reset
  // nonce for a numeric member ID, and no public menu update is needed.
  const otherUser = { id: 'staff-second-reviewer', username: 'Another reviewer' };
  await staffReviewsInteraction.execute({
    isStringSelectMenu: () => true, customId: STAFF_REVIEW_MEMBER_ID, guildId,
    guild, client, message, user: otherUser, values: [memberId],
    deferUpdate: async () => {},
  });
  let nextModal;
  await staffReviewsInteraction.execute({
    isStringSelectMenu: () => true, customId: message.components[1].components[0].custom_id,
    guildId, guild, client, message, user: otherUser, values: ['3'],
    showModal: async value => { nextModal = value.toJSON(); },
  });
  assert.equal(nextModal.custom_id, `staff_review_modal:${memberId}:3`);
  assert.equal(panelEdits, 1);
});
