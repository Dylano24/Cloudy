import assert from 'node:assert/strict';
import test from 'node:test';
import { Embed } from 'discord.js';
import { isDedicatedGamblingGuideMessage } from '../src/utils/gamblingGuideIdentity.js';
import {
  applyTemplatesToExistingMessage,
  applySavedResponsePayloadTemplates,
  prepareMessageEditPayload,
} from '../src/events/fullResponseCatalogReady.js';
import { applySavedEmbedTemplates } from '../src/services/embedTemplateService.js';

const description = 'All Cloudy gaming and economy commands must be used in this channel. Click the button below to view all available commands.';
const commands = [{ components: [{ customId: 'dedicated_commands:gambling' }] }];

function guide(title = 'Games & Economy', text = description) {
  return {
    id: 'message-id', guildId: 'guild', channelId: 'channel',
    embeds: [new Embed({ title, description: text, color: 0xFFFFFF })],
    components: commands,
  };
}

test('only the dedicated Gambling guide is exempt from automatic response templates', () => {
  assert.equal(isDedicatedGamblingGuideMessage(guide()), true);
  assert.equal(isDedicatedGamblingGuideMessage(guide('Games & economy')), true);
  assert.equal(isDedicatedGamblingGuideMessage(guide('Games & Economy', 'My custom instructions')), true);
  assert.equal(isDedicatedGamblingGuideMessage({
    embeds: [{ title: 'Games & Economy', description }],
    components: [],
  }), true);
  assert.equal(isDedicatedGamblingGuideMessage({
    embeds: [{ title: 'Games & economy', description: 'Unrelated message' }],
    components: [],
  }), false);
  assert.equal(isDedicatedGamblingGuideMessage({
    channel: { name: '🎲｜gambling' },
    embeds: [{ title: 'Games & economy', description: 'Owner-edited instructions' }],
    components: [],
  }), true);
  assert.equal(isDedicatedGamblingGuideMessage({
    embeds: [{ title: 'Shop & Economy', description }],
    components: commands,
  }), false);
  assert.equal(isDedicatedGamblingGuideMessage({
    embeds: [{ title: 'Blackjack win', description: 'You won' }],
    components: [],
  }), false);
});

test('the live guide never gets a second edit on MESSAGE_CREATE', async () => {
  let edits = 0;
  const message = {
    ...guide(),
    author: { id: 'bot' }, client: { user: { id: 'bot' } }, editable: true,
    edit: async () => { edits++; throw new Error('Unexpected post-send edit'); },
  };
  assert.equal(await applyTemplatesToExistingMessage(message, { initialCreation: true }), false);
  assert.equal(edits, 0);
  assert.equal(await applySavedEmbedTemplates(message, { initialCreation: true }), true);
  assert.equal(edits, 0);
});

test('saved responses never replace this guide with a stale lowercase title', async () => {
  const payload = guide();
  const result = await applySavedResponsePayloadTemplates(payload, {
    guildId: 'guild', channelId: 'channel',
  });
  assert.strictEqual(result, payload);
});

test('a direct Discord message.edit is not restyled for this guide', () => {
  const message = {
    ...guide('Games & economy'),
    author: { id: 'bot' }, client: { user: { id: 'bot' } },
  };
  const payload = { embeds: [{ title: 'Games & Economy', description }] };
  assert.strictEqual(prepareMessageEditPayload(message, payload), payload);
});

test('the single-message exclusion works even without a resolved channel name', async () => {
  const message = {
    ...guide(),
    channel: null, guild: null, editable: true,
  };
  assert.equal(await applySavedEmbedTemplates(message, { initialCreation: true }), true);
});
