import test from 'node:test';
import assert from 'node:assert/strict';
import {ActionRow, Collection, Embed} from 'discord.js';
import {db} from '../src/utils/database.js';
import {getEmbedRegistry} from '../src/services/embedRegistryService.js';
import {FAQ_AI_BUTTON_ID, FAQ_AI_CHANNEL_ID, reconcileFaqAiPanel, buildFaqQuestionModal} from '../src/services/faqAiService.js';

test('the existing question button becomes Assistant with the white bot without rewriting the embed', async t => {
  const values = new Map();
  t.mock.method(db, 'get', async key => structuredClone(values.get(key) ?? null));
  t.mock.method(db, 'set', async (key, value) => {values.set(key, structuredClone(value)); return true;});
  const emoji = {id: '1800000000000000099', name: 'cloudy_support_bot_white', animated: false};
  const client = {user: {id: 'cloudy'}, application: {emojis: {cache: new Collection([[emoji.id, emoji]])}},
    channels: {cache: new Collection()}, db: {get: async () => 'assistant-panel', set: async () => true}};
  const original = {title: 'Cloudy support assistant', description: 'My  original text\n\nKeep this.', color: 0x123456,
    footer: {text: 'My original footer'}, image: {url: 'https://example.test/assistant.gif'}};
  const edits = [];
  const panel = {id: 'assistant-panel', guildId: 'icon-guild', channelId: FAQ_AI_CHANNEL_ID, client,
    author: client.user, createdAt: new Date(), embeds: [new Embed(original)],
    components: [new ActionRow({type: 1, components: [{type: 2, custom_id: FAQ_AI_BUTTON_ID, label: '❔Ask a question', style: 2}]})],
    async edit(payload) {
      assert.deepEqual(Object.keys(payload), ['components']);
      edits.push(payload);
      this.components = payload.components.map(row => new ActionRow(row.toJSON?.() || row));
      return this;
    }};
  const channel = {id: FAQ_AI_CHANNEL_ID, name: '🤖│support-assistant', isTextBased: () => true, isThread: () => false,
    messages: {fetch: async () => panel}, send: async () => assert.fail('the existing assistant must not be duplicated')};
  client.channels.cache.set(channel.id, channel);
  panel.channel = channel;
  values.set('cloudy:embed-registry:icon-guild', [{guildId: 'icon-guild', channelId: FAQ_AI_CHANNEL_ID,
    messageId: panel.id, embedIndex: 0, source: 'embed-builder', manualSaved: true, explicitSave: true,
    title: original.title, snapshot: original, components: panel.components.map(row => row.toJSON()),
    createdAt: panel.createdAt.toISOString()}]);
  const result = await reconcileFaqAiPanel(client);
  assert.equal(result.id, panel.id);
  assert.equal(edits.length, 1);
  assert.deepEqual(panel.embeds[0].toJSON(), original);
  const button = panel.components[0].toJSON().components[0];
  assert.equal(button.custom_id, 'faq_ai_question');
  assert.equal(button.label, 'Assistant');
  assert.equal(button.emoji.id, emoji.id);
  const saved = (await getEmbedRegistry('icon-guild')).find(row => row.messageId === panel.id);
  assert.equal(saved.components[0].components[0].emoji.id, emoji.id, 'a later Builder Save must retain the bot icon');
  assert.equal(saved.explicitSave, true);
  assert.equal(saved.source, 'embed-builder');
  assert.equal(saved.snapshot.description, original.description);
  await reconcileFaqAiPanel(client);
  assert.equal(edits.length, 1, 'a restart/reconciliation does not keep re-editing the button');
});

test('a failed assistant icon edit never creates a duplicate assistant panel', async () => {
  const emoji = {id: '1800000000000000099', name: 'cloudy_support_bot_white'};
  let posts = 0;
  const panel = {id: 'kept-panel', author: {id: 'cloudy'}, embeds: [new Embed({title: 'Cloudy support assistant'})],
    components: [new ActionRow({type: 1, components: [{type: 2, custom_id: FAQ_AI_BUTTON_ID, label: '❔Ask a question', style: 2}]})],
    edit: async () => {throw new Error('Discord temporarily rejected the edit');}};
  const channel = {id: FAQ_AI_CHANNEL_ID, name: 'support-assistant', isTextBased: () => true,
    messages: {fetch: async () => panel}, send: async () => {posts++; return panel;}};
  const client = {user: {id: 'cloudy'}, application: {emojis: {cache: new Collection([[emoji.id, emoji]])}},
    channels: {cache: new Collection([[channel.id, channel]])}, db: {get: async () => panel.id, set: async () => true}};
  await reconcileFaqAiPanel(client);
  assert.equal(posts, 0);
});


test('the Ask Cloudy modal example omits free kits, support and the extra comma', () => {
  const modal = buildFaqQuestionModal().toJSON();
  const input = modal.components[0].components[0];
  assert.equal(input.placeholder, 'Ask about Cloudy, purchases, rules, commands or server information.');
  assert.equal(input.custom_id, 'question');
});
