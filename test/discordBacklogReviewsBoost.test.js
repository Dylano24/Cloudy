import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags } from 'discord.js';

import {
  SERVICE_REVIEW_TYPES, SERVICE_REVIEW_PANEL_TITLE, SERVICE_REVIEW_SELECT_ID,
  SERVICE_REVIEW_RATING_ID, serviceReviewChoiceRow, serviceReviewRatingRow,
  serviceReviewPanelRows, serviceReviewModal, buildPublishedServiceReview,
  normalizeLegacyServiceReviewEmbed,
} from '../src/services/serviceReviewsService.js';
import serviceReviewInteraction from '../src/events/serviceReviewsInteraction.js';
import { reconcileServiceReviewsPanel, migrateLegacyServiceReviews } from '../src/events/serviceReviewsReady.js';
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

test('panel offers exactly five requested services in order, with rating initially disabled', () => {
  assert.deepEqual(Object.values(SERVICE_REVIEW_TYPES), [
    'Cloudy bot', 'Website', 'Game servers', 'Game store', 'Services',
  ]);
  const rows = serviceReviewPanelRows().map(row => row.toJSON());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].components[0].custom_id, SERVICE_REVIEW_SELECT_ID);
  assert.deepEqual(rows[0].components[0].options.map(option => option.label), Object.values(SERVICE_REVIEW_TYPES));
  assert.equal(rows[1].components[0].custom_id, SERVICE_REVIEW_RATING_ID);
  assert.equal(rows[1].components[0].disabled, true);
  assert.deepEqual(rows[1].components[0].options.map(option => option.label),
    ['★', '★★', '★★★', '★★★★', '★★★★★']);
  assert.equal(serviceReviewChoiceRow().toJSON().components[0].options.length, 5);
  assert.equal(serviceReviewRatingRow().toJSON().components[0].disabled, true);
  const chosen = serviceReviewPanelRows('bot').map(row => row.toJSON());
  assert.equal(chosen[1].components[0].disabled, false);
  assert.equal(chosen[0].components[0].options.filter(option => option.default).length, 1);
  assert.equal(chosen[0].components[0].options.find(option => option.default).label, 'Cloudy bot');
  assert.throws(() => serviceReviewRatingRow('other'), /Invalid/);
  assert.equal(serviceReviewModal('bot', 4).toJSON().custom_id, 'service_review_modal:bot:4');
  assert.throws(() => serviceReviewModal('servers', 6), /Invalid/);
});

test('reconciliation migrates existing embed to two menus in-place, without duplicates or copy changes', async () => {
  const { guild, client } = mockClient();
  const originalEmbed = { title: SERVICE_REVIEW_PANEL_TITLE, description: 'Custom owner text must never change.' };
  let edits = 0;
  const message = {
    id: '1568560974548697170',
    author: { id: BOT }, embeds: [originalEmbed],
    components: [serviceReviewChoiceRow()],
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
  assert.equal(message.components.length, 2);
  assert.equal(message.components[1].toJSON().components[0].disabled, true);
  assert.equal(edits, 1);
  const again = await reconcileServiceReviewsPanel(client);
  assert.equal(again.action, 'preserved');
  assert.equal(edits, 1, 'must never duplicate or overwrite the existing review embed');
});

test('selection enables rating on same panel, never sends repetitive ephemeral dropdowns, then opens modal', async () => {
  const { guild, client } = mockClient();
  guild.emojis = { cache: new Collection([['1543289625035022346', {
    toString: () => '<:W84starwhite:1543289625035022346>',
  }]]) };
  const sent = [];
  addChannel(client, guild, POSTED, {
    async send(payload) { sent.push(payload); return { id: 'published' }; },
  });
  const user = { id: 'member', username: 'Listener', displayAvatarURL: () => 'https://example.com/avatar.png' };
  const publicMessage = {
    id: '1568560974548697170',
    components: serviceReviewPanelRows(),
    edits: 0,
    async edit(payload) {
      this.components = payload.components;
      this.edits += 1;
    },
  };
  let deferCount = 0;
  let replyCount = 0;
  let editCount = 0;
  const choose = {
    customId: SERVICE_REVIEW_SELECT_ID, channelId: REVIEWS, guildId: GUILD_ID,
    isStringSelectMenu: () => true, values: ['bot'],
    user, guild, client, message: publicMessage,
    deferUpdate: async () => { deferCount += 1; },
    editReply: async payload => {
      editCount += 1;
      publicMessage.components = payload.components;
    },
    reply: async () => { replyCount += 1; },
  };
  for (let i = 0; i < 4; i += 1) {
    await serviceReviewInteraction.execute(choose);
  }
  assert.equal(deferCount, 4);
  assert.equal(editCount, 4);
  assert.equal(replyCount, 0, 'no ephemeral rating dropdown spam');
  assert.equal(publicMessage.components.length, 2);
  assert.equal(publicMessage.components[1].toJSON().components[0].disabled, false);

  let shown;
  await serviceReviewInteraction.execute({
    ...choose, customId: SERVICE_REVIEW_RATING_ID, values: ['4'],
    showModal: async modal => { shown = modal.toJSON(); },
  });
  assert.equal(shown.custom_id, 'service_review_modal:bot:4');
  assert.equal(shown.components[0].components[0].custom_id, 'service_review_comment');
  assert.equal(publicMessage.edits, 1, 'reset original message rather than add another one');
  assert.equal(publicMessage.components[1].toJSON().components[0].disabled, true);

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
  assert.ok(embed.description.startsWith('**Cloudy bot**\n\n'));
  assert.ok(!embed.description.includes('Product or service'));
  assert.equal(embed.timestamp, undefined, 'review footer cannot include a timestamp');
  assert.ok(embed.description.includes('<:W84starwhite:1543289625035022346>'.repeat(4)));
  assert.match(embed.description, /Excellent experience/);
  assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
});

test('rating cannot open a modal before this reviewer selects a service', async () => {
  const { guild, client } = mockClient();
  let shown = false;
  let reply;
  await serviceReviewInteraction.execute({
    customId: SERVICE_REVIEW_RATING_ID, channelId: REVIEWS, guildId: GUILD_ID,
    isStringSelectMenu: () => true, values: ['5'],
    user: { id: 'different-user' }, guild, client,
    showModal: async () => { shown = true; },
    reply: async payload => { reply = payload; },
  });
  assert.equal(shown, false);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /Choose a product or service first/);
});

test('published service review uses only the selected category as heading and the Staff Reviews footer style', () => {
  for (const [type, label] of Object.entries(SERVICE_REVIEW_TYPES)) {
    const embed = buildPublishedServiceReview({
      user: { username: 'Reviewer', displayAvatarURL: () => 'https://example.com/avatar.png' },
    }, type, 5, 'Perfect!', '<:W84starwhite:1543289625035022346>').toJSON();
    assert.ok(embed.description.startsWith(`**${label}**\n\n**Rating**`),
      `Only the selected service heading should be shown for ${label}`);
    assert.ok(!embed.description.includes('Product or service'));
    assert.equal(embed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
    assert.ok(!Object.hasOwn(embed, 'timestamp'), 'Must show footer without Today at time');
    assert.ok(embed.description.endsWith('**Experience**\nPerfect!'));
  }
});

test('legacy Service Reviews are corrected in their existing message, without changing rating or experience', async () => {
  const { guild, client } = mockClient();
  let edits = 0, skippedEdits = 0;
  const old = {
    color: 0xA14425,
    description: '**Product or service**\nGame servers\n\n**Rating**\n<:W84starwhite:1543289625035022346>\n\n**Experience**\nPerfect!',
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    timestamp: '2026-11-08T02:04:00.000Z',
    thumbnail: { url: 'https://example.com/unchanged-logo.gif' },
  };
  const legacy = {
    author: { id: BOT },
    embeds: [{ toJSON: () => old }],
    async edit(payload) {
      edits += 1;
      assert.ok(!Object.hasOwn(payload, 'content'));
      assert.ok(!Object.hasOwn(payload, 'components'));
      this.embeds = payload.embeds;
    },
  };
  const unrelated = {
    author: { id: 'some-other-bot' },
    embeds: [{ description: old.description }],
    async edit() { skippedEdits += 1; },
  };
  const unknown = {
    author: { id: BOT },
    embeds: [{ description: '**Product or service**\nUnknown category\n\n**Rating**\n5' }],
    async edit() { skippedEdits += 1; },
  };
  addChannel(client, guild, POSTED, {
    messages: {
      async fetch() {
        return new Collection([['legacy', legacy], ['unrelated', unrelated], ['unknown', unknown]]);
      },
    },
  });
  const first = await migrateLegacyServiceReviews(client);
  assert.deepEqual(first, { updated: 1 });
  assert.equal(edits, 1);
  assert.equal(skippedEdits, 0);
  const output = legacy.embeds[0];
  assert.ok(output.description.startsWith('**Game servers**\n\n**Rating**'));
  assert.ok(!output.description.includes('Product or service'));
  assert.ok(output.description.endsWith('**Experience**\nPerfect!'));
  assert.equal(output.color, old.color);
  assert.deepEqual(output.thumbnail, old.thumbnail);
  assert.deepEqual(output.footer, old.footer);
  assert.ok(!Object.hasOwn(output, 'timestamp'));
  assert.equal(normalizeLegacyServiceReviewEmbed(output), null);
  const second = await migrateLegacyServiceReviews(client);
  assert.deepEqual(second, { updated: 0 });
  assert.equal(edits, 1, 'repeat startup must not edit the same review again');
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
    ['1554538607233073182', '1568769178540707934', [
      { type: 2, style: 2, label: 'Instructions', custom_id: 'cloudy_builder_action:existing' },
    ]],
    ['1554538586001645679', '1568514711941816442', [
      { type: 2, style: 2, label: 'Assistant', custom_id: 'faq_ai_question', emoji: { id: '1568567297545732228', name: 'cloudy_support_bot_white' } },
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
  assert.deepEqual(first, { checked: 4, updated: 4 });
  assert.equal(messages.get('1568526805072216085').components[0].components[0].emoji.id, '1543303628159320165');
  assert.equal(messages.get('1568526805072216085').components[0].components[1].emoji.id, '1568706168006770719');
  assert.equal(messages.get('1568769178540707934').components[0].components[0].emoji.id, '1543287391131803749');
  assert.equal(messages.get('1568543862908129352').components[0].components[0].emoji.id, '1543303628159320165');
  assert.equal(messages.get('1568514711941816442').components[0].components[0].label, 'Cloudy assistant');
  assert.equal(messages.get('1568514711941816442').components[0].components[0].emoji.id, '1568567297545732228');
  const second = await reconcileRequestedButtonEmojis(client);
  assert.deepEqual(second, { checked: 4, updated: 0 });
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
