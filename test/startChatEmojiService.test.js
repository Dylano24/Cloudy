import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureLargeStartChatEmoji, startChatEmoji, ORIGINAL_START_CHAT_EMOJI,
  START_CHAT_ENLARGED_EMOJI_NAME,
} from '../src/services/startChatEmojiService.js';
import { reconcileRequestedButtonEmojis } from '../src/events/cloudyRequestedButtonsReady.js';
import { buildTicketPanelComponents } from '../src/services/ticketPanelBuilder.js';

test('larger application emoji is created once with the new PNG and reused', async () => {
  let creations = 0;
  const cache = new Map();
  const client = {
    application: { emojis: {
      cache,
      async fetch() { return cache; },
      async create({ name, attachment }) {
        creations += 1;
        assert.equal(name, START_CHAT_ENLARGED_EMOJI_NAME);
        assert.ok(Buffer.isBuffer(attachment) && attachment.length > 1000);
        assert.equal(attachment.subarray(1, 4).toString(), 'PNG');
        return { id: '1800000000000000100', name };
      },
    } },
  };
  assert.equal(startChatEmoji(client).id, ORIGINAL_START_CHAT_EMOJI.id);
  const [first, second] = await Promise.all([
    ensureLargeStartChatEmoji(client), ensureLargeStartChatEmoji(client),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.id, '1800000000000000100');
  assert.equal(creations, 1);
  assert.equal(startChatEmoji(client).id, first.id);
  assert.equal((await ensureLargeStartChatEmoji(client)).id, first.id);
  assert.equal(creations, 1);
});

test('Start chat uses enlarged emoji in the original button without changing the embed', async () => {
  const guildId = '1532882647838228723';
  const channelId = '1554538650761691260';
  const messageId = '1568543862908129352';
  const emoji = { id: '1800000000000000100', name: START_CHAT_ENLARGED_EMOJI_NAME };
  const client = {
    user: { id: 'bot' },
    application: { emojis: { cache: new Map([[emoji.id, emoji]]) } },
    guilds: { cache: new Map() },
  };
  const embed = { title: 'Contact the staff team', description: 'Never change this text' };
  const message = {
    author: client.user, embeds: [embed],
    components: [{ type: 1, components: [
      { type: 2, style: 2, custom_id: 'create_ticket', label: 'Start chat',
        emoji: ORIGINAL_START_CHAT_EMOJI },
      { type: 2, style: 5, label: 'Cloudy assistant', url: 'https://discord.com/' },
    ] }],
    edits: 0,
    async edit({ components }) { this.components = components; this.edits += 1; },
  };
  const channel = { id: channelId, messages: { fetch: async id => String(id) === messageId ? message : null } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  client.guilds.cache.set(guildId, guild);
  assert.deepEqual(await reconcileRequestedButtonEmojis(client), { checked: 1, updated: 1 });
  assert.equal(message.components[0].components[0].emoji.id, emoji.id);
  assert.equal(message.components[0].components[1].label, 'Cloudy assistant');
  assert.deepEqual(message.embeds, [embed]);
  assert.deepEqual(await reconcileRequestedButtonEmojis(client), { checked: 1, updated: 0 });
  assert.equal(message.edits, 1);

  const built = buildTicketPanelComponents(client, guildId, {});
  assert.equal(built[0].toJSON().components[0].emoji.id, emoji.id);
  assert.equal(built[0].toJSON().components[0].label, 'Start Chat');
});
