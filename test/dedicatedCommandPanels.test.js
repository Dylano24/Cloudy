import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { buildDedicatedGuidePayload, scheduleDedicatedChannelGuide } from '../src/services/dedicatedChannelService.js';
import { applySavedEmbedTemplates } from '../src/services/embedTemplateService.js';
import panels from '../src/interactions/buttons/dedicatedCommands.js';

test('shop schedules a reappear after every two messages and ignores its own guide', t => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    timers.push({ callback, delay });
    return { unref() {} };
  });
  const client = { user: { id: 'cloudy' } };
  const channel = { id: 'shop-two-messages', name: 'shop', client, isTextBased: () => true, isSendable: () => true };
  const guild = { id: 'shop-two-guild', client, channels: { cache: new Collection([[channel.id, channel]]) } };
  const message = { guild, channel, author: { id: 'member' }, embeds: [] };
  const ownGuide = { ...message, author: client.user, embeds: [{ title: 'Shop & Economy' }] };
  assert.equal(scheduleDedicatedChannelGuide(ownGuide), false);
  scheduleDedicatedChannelGuide(message);
  assert.equal(timers.length, 0, 'the first message does not move the shop');
  scheduleDedicatedChannelGuide(message);
  assert.equal(timers.length, 1, 'the second message schedules the shop move');
  assert.equal(timers[0].delay, 1500, 'the existing refresh delay stays unchanged');
});

for (const key of ['gambling', 'shop']) {
  test(`${key} panel is compact with a Commands button`, () => {
    const result = buildDedicatedGuidePayload(key);
    assert.equal(result.embeds[0].title, key === 'shop' ? 'Shop & Economy' : 'Games & Economy');
    assert.ok(!result.embeds[0].description.includes('/balance'));
    assert.equal(result.components[0].toJSON().components[0].custom_id, `dedicated_commands:${key}`);
  });
  test(`${key} Commands opens only the requested categories privately for exactly 5 minutes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reply, deleted = false;
    const interaction = { reply: async payload => { reply = payload; }, deleteReply: async () => { deleted = true; } };
    await panels.execute(interaction, {}, [key]);
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    const text = reply.embeds[0].description;
    assert.ok(text.includes('/balance'));
    assert.equal(text.includes('/blackjack'), key === 'gambling');
    assert.equal(text.includes('/work'), key === 'gambling');
    assert.equal(text.includes('/buy'), key === 'shop');
    t.mock.timers.tick(299999); assert.equal(deleted, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(deleted, true);
  });
}

test('new panels preserve manual Builder content and Commands buttons on later moves', () => {
  const existing = {
    embeds: [new Embed({ title: 'My games', description: 'Custom saved wording', color: 123 })],
    components: buildDedicatedGuidePayload('gambling').components,
  };
  const moved = buildDedicatedGuidePayload('gambling', existing);
  assert.equal(moved.embeds[0].title, 'My games');
  assert.equal(moved.embeds[0].description, 'Custom saved wording');
  assert.deepEqual(moved.components, existing.components);
});


// Regression: the guide must already have its correct title when sent.
// No other existing style or custom text may be changed by the fix.
test('Gambling guide normalizes the old lowercase title in the outgoing payload', () => {
  const description = 'All Cloudy gaming and economy commands must be used in this channel. Click the button below to view all available commands.';
  const source = new Embed({
    title: 'Games & economy',
    description,
    color: 0xFFFFFF,
    thumbnail: { url: 'https://example.com/logo.png' },
    footer: { text: 'Existing footer' },
  });
  const original = source.toJSON();
  const components = buildDedicatedGuidePayload('gambling').components;
  const payload = buildDedicatedGuidePayload('gambling', { embeds: [source], components });

  assert.equal(payload.embeds[0].title, 'Games & Economy');
  assert.deepEqual({ ...payload.embeds[0], title: 'Games & economy' }, original);
  assert.equal(source.toJSON().title, 'Games & economy');
  assert.deepEqual(payload.components, components);
});

test('Gambling guide does not receive a second visible title edit after posting', async () => {
  const description = 'All Cloudy gaming and economy commands must be used in this channel. Click the button below to view all available commands.';
  let edits = 0;
  const matched = await applySavedEmbedTemplates({
    guildId: 'guild', channelId: 'gambling', editable: true,
    channel: { name: '🎲｜gambling' },
    embeds: [new Embed({ title: 'Games & Economy', description })],
    edit: async () => { edits += 1; },
  }, { initialCreation: true });
  assert.equal(matched, true);
  assert.equal(edits, 0);
});

test('Gambling guide outgoing title stays canonical with customized description', () => {
  const original = new Embed({ title: ' Games & economy ', description: 'Custom saved guide wording', color: 0x123456, footer: { text: 'My footer' } });
  const before = original.toJSON();
  const payload = buildDedicatedGuidePayload('gambling', { embeds: [original], components: buildDedicatedGuidePayload('gambling').components });
  assert.equal(payload.embeds[0].title, 'Games & Economy');
  assert.deepEqual({ ...payload.embeds[0], title: ' Games & economy ' }, before);
  assert.deepEqual(original.toJSON(), before, 'No mutation of the existing embed');
  const custom = buildDedicatedGuidePayload('gambling', { embeds: [new Embed({ title: 'My games', description: 'Keep title' })] });
  assert.equal(custom.embeds[0].title, 'My games');
});

test('Gambling title is never visibly edited after a reappeared post with custom text', async () => {
  let edits = 0;
  const matched = await applySavedEmbedTemplates({
    guildId: 'guild', channelId: 'gambling', editable: true,
    channel: { name: '🎲｜gambling' },
    embeds: [new Embed({ title: 'Games & Economy', description: 'Customized text' })],
    edit: async () => { edits++; },
  }, { initialCreation: true });
  assert.equal(matched, true);
  assert.equal(edits, 0);
});

test('Music Commands opens the complete slash list privately and expires after five minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reply;
  let deleted = false;
  const interaction = {
    reply: async payload => { reply = payload; },
    deleteReply: async () => { deleted = true; },
  };
  await panels.execute(interaction, {}, ['music']);
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.equal(reply.embeds[0].toJSON().title, 'Music commands');
  assert.match(reply.embeds[0].toJSON().description, /\/now playing/);
  assert.match(reply.embeds[0].toJSON().description, /\/music shuffle/);
  assert.ok(!reply.embeds[0].toJSON().description.includes('/blackjack'));
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  t.mock.timers.tick(299_999);
  assert.equal(deleted, false);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(deleted, true);
});
