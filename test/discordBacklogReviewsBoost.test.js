import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';

import {
  SERVICE_REVIEW_TYPES, SERVICE_REVIEW_PANEL_TITLE, SERVICE_REVIEW_SELECT_ID,
  serviceReviewChoiceRow, serviceReviewRatingRow, serviceReviewModal,
  buildPublishedServiceReview,
} from '../src/services/serviceReviewsService.js';
import serviceReviewInteraction from '../src/events/serviceReviewsInteraction.js';
import { reconcileServiceReviewsPanel } from '../src/events/serviceReviewsReady.js';
import boostEvent, { buildGuildBoostAnnouncement } from '../src/events/guildBoostAnnouncement.js';
import { reconcileRequestedButtonEmojis } from '../src/events/cloudyRequestedButtonsReady.js';
import { buildTicketPanelComponents } from '../src/services/ticketPanelBuilder.js';
import { isBoostInstructionsAction } from '../src/interactions/buttons/cloudyBuilderAction.js';

const GUILD_ID = '1532882647838228723';
const BOT = '1534506224312389863';
const REVIEWS = '1568553373286801450';
const POSTED = '1568553442870558720';

function mockClient() {
  const guild = { id: GUILD_ID, channels: { cache: new Collection() } };
  const client = {
    user: { id: BOT },
    guilds: { cache: new Collection([[GUILD_ID, guild]]) },
    channels: { cache: new Collection() },
  };
  return { guild, client };
}
function addChannel(client, guild, id, extras = {}) {
  const channel = {
    id, guild, guildId: guild.id,
    name: id === '1554538607233073182' ? '🔹│boost' : '',
    isTextBased: () => true,
    isSendable: () => true,
    messages: { fetch: async () => null },
    ...extras,
  };
  guild.channels.cache.set(id, channel);
  client.channels.cache.set(id, channel);
  return channel;
}

test('review selector is limited to services the owner already described', () => {
  assert.deepEqual(Object.values(SERVICE_REVIEW_TYPES), [
    'Game servers', 'Website', 'Game store', 'Products & services',
    'Website development', 'Cloudy bot',
  ]);
  const choices = serviceReviewChoiceRow().toJSON().components[0];
  assert.equal(choices.custom_id, SERVICE_REVIEW_SELECT_ID);
  assert.equal(choices.options.length, 6);
  const rating = serviceReviewRatingRow('servers').toJSON().components[0];
  assert.equal(rating.custom_id, 'service_review_rating:servers');
  assert.deepEqual(rating.options.map(x => x.label), ['★', '★★', '★★★', '★★★★', '★★★★★']);
  assert.throws(() => serviceReviewRatingRow('other'), /Invalid/);
  assert.equal(serviceReviewModal('bot', 4).toJSON().custom_id, 'service_review_modal:bot:4');
  assert.throws(() => serviceReviewModal('servers', 6), /Invalid/);
});

test('reconciliation adds selectors to owner-authored service review embed in place and once', async () => {
  const { guild, client } = mockClient();
  const originalEmbed = { title: SERVICE_REVIEW_PANEL_TITLE, description: 'Custom owner text must never change.' };
  let edits = 0;
  const message = {
    id: '1568560974548697170',
    author: { id: BOT }, embeds: [originalEmbed], components: [],
    async edit(payload) {
      edits += 1;
      assert.ok(!Object.hasOwn(payload, 'embeds'), 'must not overwrite owner-authored embed');
      this.components = payload.components;
      return this;
    },
  };
  addChannel(client, guild, REVIEWS, {
    messages: {
      fetch: async messageId => String(messageId) === message.id ? message : null,
    },
  });
  const first = await reconcileServiceReviewsPanel(client);
  assert.equal(first.action, 'updated');
  assert.equal(message.id, '1568560974548697170');
  assert.equal(message.embeds[0], originalEmbed);
  assert.equal(edits, 1);
  const again = await reconcileServiceReviewsPanel(client);
  assert.equal(again.action, 'preserved');
  assert.equal(edits, 1, 'must never duplicate or overwrite the existing review embed');
});

test('category selection -> private stars -> comment modal -> posted review', async () => {
  const { guild, client } = mockClient();
  const sent = [];
  addChannel(client, guild, POSTED, {
    async send(payload) { sent.push(payload); return { id: 'published' }; },
  });
  const user = { id: 'member', username: 'Listener', displayAvatarURL: () => 'https://example.com/avatar.png' };
  let reply;
  const choose = {
    customId: SERVICE_REVIEW_SELECT_ID, channelId: REVIEWS, guildId: GUILD_ID,
    isStringSelectMenu: () => true, values: ['bot'],
    user, guild, client,
    reply: async payload => { reply = payload; },
  };
  await serviceReviewInteraction.execute(choose);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.equal(reply.components[0].toJSON().components[0].custom_id, 'service_review_rating:bot');

  let shown;
  await serviceReviewInteraction.execute({
    ...choose, customId: 'service_review_rating:bot', values: ['4'],
    showModal: async modal => { shown = modal.toJSON(); },
  });
  assert.equal(shown.custom_id, 'service_review_modal:bot:4');
  assert.equal(shown.components[0].components[0].custom_id, 'service_review_comment');

  let deferred, result;
  await serviceReviewInteraction.execute({
    ...choose, customId: 'service_review_modal:bot:4',
    isStringSelectMenu: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Excellent experience.' },
    deferReply: async payload => { deferred = payload; },
    editReply: async payload => { result = payload; },
    deleteReply: async () => {},
  });
  assert.equal(deferred.flags, MessageFlags.Ephemeral);
  assert.match(result.content, /published/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  const embed = sent[0].embeds[0].toJSON();
  assert.match(embed.description, /\*\*Product or service\*\*\nCloudy bot/);
  assert.match(embed.description, /\*\*Rating\*\*\n⭐{4}/);
  assert.match(embed.description, /Excellent experience/);
  assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
});

test('boost embed contains exact requested wording and never invents counts', async () => {
  const expected = buildGuildBoostAnnouncement('1532882647838228723', 17);
  assert.equal(expected.embeds[0].title, 'Cloudy Inc. just got a boost!');
  assert.equal(expected.embeds[0].description,
    '<@1532882647838228723> just boosted the server, helping us build something even better. Thank you for the support!\n\nTotal server boosts: 17');
  assert.deepEqual(expected.allowedMentions, { parse: [] });
  assert.throws(() => buildGuildBoostAnnouncement('1532882647838228723', null), /Invalid/);

  const { client, guild } = mockClient();
  const sent = [];
  guild.premiumSubscriptionCount = 17;
  addChannel(client, guild, '1554538607233073182', {
    async send(payload) { sent.push(payload); },
  });
  const oldMember = { premiumSinceTimestamp: null };
  const newMember = {
    guild, client, id: '1532882647838228723', premiumSinceTimestamp: Date.now(),
  };
  await boostEvent.execute(oldMember, newMember);
  assert.equal(sent.length, 1);
  await boostEvent.execute({ premiumSinceTimestamp: Date.now() - 1000 }, newMember);
  assert.equal(sent.length, 1, 'name/role updates cannot cause duplicate boost messages');
});

test('only missing button emoji are added; existing owner-customized embeds stay intact', async () => {
  const { client, guild } = mockClient();
  const messages = new Map();
  const targets = [
    ['1556354678407827637', '1568526805072216085', [
      { type: 2, style: 5, label: 'Contact us', url: 'https://discord.test/contact' },
      { type: 2, style: 5, label: 'Rust support', url: 'https://discord.test/rust' },
    ]],
    ['1554538607233073182', '1568741702309646388', [
      { type: 2, style: 2, label: 'Instructions', custom_id: 'cloudy_builder_action:existing' },
    ]],
    ['1554538650761691260', '1568543862908129352', [
      { type: 2, style: 2, label: 'Start chat', custom_id: 'create_ticket', emoji: { name: '💬' } },
    ]],
  ];
  for (const [channelId, messageId, buttons] of targets) {
    const original = { title: 'Owner embed', description: 'Owner-provided text' };
    const message = {
      id: messageId, author: { id: BOT }, embeds: [original], components: [{ type: 1, components: buttons }],
      edits: 0,
      async edit(payload) { this.components = payload.components; this.edits++; },
    };
    messages.set(messageId, message);
    addChannel(client, guild, channelId, { messages: { fetch: async () => message } });
  }
  const first = await reconcileRequestedButtonEmojis(client);
  assert.deepEqual(first, { checked: 3, updated: 3 });
  assert.equal(messages.get('1568526805072216085').components[0].components[0].emoji.id, '1543303628159320165');
  assert.equal(messages.get('1568526805072216085').components[0].components[1].emoji.id, '1568706168006770719');
  assert.equal(messages.get('1568741702309646388').components[0].components[0].emoji.id, '1543287391131803749');
  assert.equal(messages.get('1568543862908129352').components[0].components[0].emoji.id, '1543303628159320165');
  const second = await reconcileRequestedButtonEmojis(client);
  assert.deepEqual(second, { checked: 3, updated: 0 });
  for (const message of messages.values()) {
    assert.equal(message.edits, 1);
    assert.equal(message.embeds[0].description, 'Owner-provided text');
  }
});

test('Start chat supports upgraded emoji and Reward boost only removes its Instructions logo', () => {
  const rows = buildTicketPanelComponents(null, GUILD_ID, {}, [{
    type: 1,
    components: [{ type: 2, custom_id: 'create_ticket', style: 2, label: 'Start chat', emoji: { name: '💬' } }],
  }]);
  const chat = rows[0].toJSON().components[0];
  assert.equal(chat.custom_id, 'create_ticket');
  assert.equal(chat.emoji.id, '1543303628159320165');
  assert.equal(isBoostInstructionsAction({
    guildId: GUILD_ID, channelId: '1554538607233073182',
  }, '8ff2465c22214a11b01ad798'), true);
  assert.equal(isBoostInstructionsAction({
    guildId: GUILD_ID, channelId: '1556354678407827637',
  }, '8ff2465c22214a11b01ad798'), false);
});
