import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';
import serviceReviewInteraction from '../src/events/serviceReviewsInteraction.js';
import {
  SERVICE_REVIEW_SELECT_ID, SERVICE_REVIEW_RATING_ID, SERVICE_REVIEW_PANEL_MESSAGE_ID,
  SERVICE_REVIEW_PANEL_TITLE, SERVICE_REVIEWS_CHANNEL_ID, SERVICE_POSTED_REVIEWS_CHANNEL_ID,
  serviceReviewPanelRows,
} from '../src/services/serviceReviewsService.js';

test('after a successful service review, both existing dropdowns reset without changing the embed', async () => {
  const guildId = '1532882647838228723';
  const user = { id: 'service-reset-reviewer', username: 'Reviewer',
    displayAvatarURL: () => 'https://example.com/avatar.png' };
  const botId = '1534506224312389863';
  const originalEmbed = { title: SERVICE_REVIEW_PANEL_TITLE, description: 'Owner-created guide remains intact' };
  let edits = 0;
  const panel = {
    id: SERVICE_REVIEW_PANEL_MESSAGE_ID, author: { id: botId },
    embeds: [originalEmbed], components: serviceReviewPanelRows(),
    async edit(payload) {
      assert.deepEqual(Object.keys(payload), ['components']);
      this.components = payload.components;
      edits += 1;
    },
  };
  const posted = [];
  const channels = new Collection();
  const reviewChannel = {
    id: SERVICE_REVIEWS_CHANNEL_ID, name: 'service-reviews',
    isTextBased: () => true, isSendable: () => true,
    messages: { async fetch(id) {
      return String(id) === SERVICE_REVIEW_PANEL_MESSAGE_ID ? panel : null;
    } },
  };
  const postedChannel = {
    id: SERVICE_POSTED_REVIEWS_CHANNEL_ID, name: 'service-posted-reviews',
    isTextBased: () => true, isSendable: () => true,
    async send(payload) { posted.push(payload); return { id: '1750000000000000000' }; },
  };
  channels.set(reviewChannel.id, reviewChannel);
  channels.set(postedChannel.id, postedChannel);
  const guild = {
    id: guildId,
    channels: { cache: channels },
    emojis: { cache: new Collection([['1543289625035022346', {
      toString: () => '<:W84starwhite:1543289625035022346>',
    }]]) },
  };
  const client = { user: { id: botId },
    guilds: { cache: new Collection([[guildId, guild]]) },
    channels: { cache: channels } };
  reviewChannel.guild = guild;
  postedChannel.guild = guild;

  async function select(customId, value, onModal = null) {
    let shown = null;
    await serviceReviewInteraction.execute({
      customId, channelId: SERVICE_REVIEWS_CHANNEL_ID, guildId,
      guild, client, user, isStringSelectMenu: () => true, values: [value],
      deferUpdate: async () => {},
      showModal: async modal => { shown = modal.toJSON(); if (onModal) onModal(shown); },
      reply: async () => { throw new Error('No extra private choice panel'); },
    });
    return shown;
  }

  await select(SERVICE_REVIEW_SELECT_ID, 'store');
  assert.equal(edits, 0, 'choosing service cannot redraw public panel');
  const modal = await select(SERVICE_REVIEW_RATING_ID, '4');
  assert.equal(modal.custom_id, 'service_review_modal:store:4');
  let result;
  await serviceReviewInteraction.execute({
    customId: modal.custom_id, channelId: SERVICE_REVIEWS_CHANNEL_ID, guildId,
    guild, client, user, isModalSubmit: () => true, isStringSelectMenu: () => false,
    fields: { getTextInputValue: () => 'It was good.' },
    deferReply: async payload => assert.equal(payload.flags, MessageFlags.Ephemeral),
    editReply: async payload => { result = payload.content; },
    deleteReply: async () => {},
  });
  assert.equal(posted.length, 1);
  assert.match(result, /published/);
  assert.equal(edits, 1, 'one reset after success');
  assert.deepEqual(panel.embeds, [originalEmbed]);
  assert.equal(panel.components.length, 2);
  const serviceMenu = panel.components[0].components[0];
  const ratingMenu = panel.components[1].components[0];
  assert.match(serviceMenu.custom_id, /^service_review_service:reset:/);
  assert.match(ratingMenu.custom_id, /^service_review_rating:reset:/);
  assert.equal(serviceMenu.placeholder, 'Choose a product or service');
  assert.equal(ratingMenu.placeholder, 'Choose your rating');
  assert.equal(ratingMenu.disabled, false);
  assert.ok(serviceMenu.options.every(option => !option.default));
  assert.ok(ratingMenu.options.every(option => !option.default));

  // The new internal IDs work for the next review and retain the same UI.
  await select(serviceMenu.custom_id, 'bot');
  const nextModal = await select(ratingMenu.custom_id, '5');
  assert.equal(nextModal.custom_id, 'service_review_modal:bot:5');
  assert.equal(edits, 1, 'new choices do not publicly edit the menu');
});

test('failed service review submission does not reset the existing dropdowns', async () => {
  // A failure must not clear an in-progress selection or falsely claim success.
  const guildId = '1532882647838228723';
  const user = { id: 'service-reset-failure', username: 'Reviewer',
    displayAvatarURL: () => 'https://example.com/avatar.png' };
  const panel = { edits: 0, async edit() { this.edits += 1; } };
  const channels = new Collection([
    [SERVICE_REVIEWS_CHANNEL_ID, { id: SERVICE_REVIEWS_CHANNEL_ID, messages: {
      fetch: async () => panel,
    }, isTextBased: () => true }],
  ]);
  const guild = { id: guildId, channels: { cache: channels },
    emojis: { cache: new Collection() } };
  const client = { user: { id: 'bot' }, guilds: { cache: new Collection([[guildId, guild]]) },
    channels: { cache: channels } };
  let reply = null;
  await serviceReviewInteraction.execute({
    customId: 'service_review_modal:bot:4',
    channelId: SERVICE_REVIEWS_CHANNEL_ID, guildId, guild, client, user,
    isModalSubmit: () => true, isStringSelectMenu: () => false,
    fields: { getTextInputValue: () => 'My review' },
    deferReply: async () => {},
    editReply: async payload => { reply = payload.content; },
  });
  assert.match(reply, /unavailable/);
  assert.equal(panel.edits, 0);
});
