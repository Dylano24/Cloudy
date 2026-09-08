import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../src/events/cloudyFixGuideInteraction.js';
import { MessageFlags } from 'discord.js';

function interaction(names = ['Owner']) {
  return {
    isButton: () => false, isModalSubmit: () => true,
    customId: 'cloudy_fix_guide_ask_modal', channelId: '1546229542027534478',
    guild: { id: 'test', ownerId: 'user' }, user: { id: 'user', username: 'owner' },
    member: { roles: { cache: { some: fn => names.some(name => fn({ name })) } } },
    fields: { getTextInputValue: () => 'What is 2 plus 2?' }, client: {},
  };
}

test('Ask acknowledges ephemerally before API calls and edits the answer', async t => {
  const previous = globalThis.fetch;
  const previousKey = process.env.CLOUDY_AI_MODEL;
  process.env.CLOUDY_AI_MODEL = 'qwen3:4b';
  t.after(() => {
    globalThis.fetch = previous;
    if (previousKey === undefined) delete process.env.CLOUDY_AI_MODEL; else process.env.CLOUDY_AI_MODEL = previousKey;
  });
  const item = interaction();
  let acknowledged = false, answered = false;
  item.reply = async payload => {
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.match(payload.content, /investigating/);
    acknowledged = true; item.replied = true;
  };
  item.editReply = async payload => { answered = true; assert.equal(payload.embeds[0].data.description, '4'); };
  item.followUp = async () => assert.fail('Unexpected followup');
  globalThis.fetch = async url => {
    assert.equal(acknowledged, true);
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    return new Response(JSON.stringify({ message: { content: '4' } }));
  };
  await handler.execute(item);
  assert.equal(answered, true);
});

test('server owner without Owner role is denied before modal or retrieval', async () => {
  const item = interaction(['Admin']);
  let denied = false;
  item.reply = async payload => { denied = true; assert.equal(payload.flags, MessageFlags.Ephemeral); assert.match(payload.content, /Owner role only/); };
  await handler.execute(item);
  assert.equal(denied, true);
});

test('gray Ask opens the expected modal for Owner', async () => {
  const item = interaction(['oWnEr']);
  item.isButton = () => true; item.isModalSubmit = () => false; item.customId = 'cloudy_fix_guide_ask';
  let opened = false;
  item.showModal = async modal => { opened = true; assert.equal(modal.data.custom_id, 'cloudy_fix_guide_ask_modal'); };
  await handler.execute(item);
  assert.equal(opened, true);
});
