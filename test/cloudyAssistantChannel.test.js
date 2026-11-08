import test from 'node:test';
import assert from 'node:assert/strict';
import { FAQ_AI_CHANNEL_ID, FAQ_AI_BUTTON_ID, FAQ_AI_MODAL_ID } from '../src/services/faqAiService.js';
import faqAiInteraction, { isFaqChannel } from '../src/events/faqAiInteraction.js';
import { getCloudyChannelDefinition } from '../src/services/cloudyChannelResolver.js';

const ACTIVE_CHANNEL = '1554538586001645679';
const OLD_CHANNEL = '1534654577385672917';

test('assistant channel ID matches the verified live panel and channel resolver', () => {
  assert.equal(FAQ_AI_CHANNEL_ID, ACTIVE_CHANNEL);
  const config = getCloudyChannelDefinition('supportAssistant');
  assert.equal(config.legacyId, ACTIVE_CHANNEL);
  assert.ok(config.aliases.includes('cloudy-assistant'));
  assert.equal(getCloudyChannelDefinition('faq').legacyId, OLD_CHANNEL,
    'changing the assistant must not silently change the separate FAQ channel definition');
});

test('both button and modal accept the actual Cloudy assistant channel', () => {
  for (const customId of [FAQ_AI_BUTTON_ID, FAQ_AI_MODAL_ID]) {
    const interaction = { channelId: ACTIVE_CHANNEL, channel: { name: '🤖│cloudy-assistant' }, customId };
    assert.equal(isFaqChannel(interaction), true);
    assert.equal(isFaqChannel({ ...interaction, channelId: '0' }), true,
      'renamed assistant still works through the exact alias');
    assert.equal(isFaqChannel({ ...interaction, channelId: '0', channel: { name: 'random-channel' } }), false);
    assert.equal(isFaqChannel({ ...interaction, channelId: OLD_CHANNEL, channel: { name: 'general' } }), false);
  }
});

test('button in an unrelated channel is denied without opening a modal', async () => {
  let reply, modalOpened = false;
  const interaction = {
    channelId: '123456789012345678',
    channel: { name: 'random-channel' },
    customId: FAQ_AI_BUTTON_ID,
    isButton: () => true,
    isModalSubmit: () => false,
    reply: async value => { reply = value; },
    showModal: async () => { modalOpened = true; },
    deleteReply: async () => {},
  };
  await faqAiInteraction.execute(interaction, {});
  assert.equal(modalOpened, false);
  assert.match(reply.content, /only be used in the FAQ channel/);
});
