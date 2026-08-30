import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { db } from '../src/utils/database.js';
import gamble from '../src/commands/Economy/gamble.js';
import fight from '../src/commands/Fun/fight.js';
import flip from '../src/commands/Fun/flip.js';
import roll from '../src/commands/Fun/roll.js';
import {
  enforceDedicatedCommandChannel,
  ensureDedicatedChannelGuides,
  scheduleDedicatedChannelGuide,
} from '../src/services/dedicatedChannelService.js';
import { createError, ErrorTypes, handleInteractionError } from '../src/utils/errorHandler.js';

function fixture(mode = 'reply') {
  const sent = [];
  const gambling = {
    id: '100000000000000001', name: '🎲｜gambling',
    isTextBased: () => true, isSendable: () => true,
  };
  const shop = {
    id: '100000000000000002', name: '🛒｜shop',
    isTextBased: () => true, isSendable: () => true,
  };
  const guild = {
    id: 'dedicated-channel-test-guild', client: { user: { id: 'cloudy-bot' } },
    channels: { cache: new Collection([[gambling.id, gambling], [shop.id, shop]]), fetch: async () => {} },
  };
  const capture = method => async payload => { sent.push({ method, payload }); return null; };
  const interaction = {
    id: 'interaction-id', user: { id: 'user-id' }, guild, guildId: guild.id,
    channelId: '100000000000000003',
    createdTimestamp: Date.now(),
    isChatInputCommand: () => true,
    replied: mode === 'followUp', deferred: mode === 'editReply',
    reply: capture('reply'), editReply: capture('editReply'), followUp: capture('followUp'),
    fetchReply: async () => null,
  };
  return { sent, interaction, guild, gambling, shop };
}

for (const [name, command] of Object.entries({ gamble, fight, flip, roll })) {
  test(`/${name} rejects the wrong channel before game logic and shows the requested message`, async () => {
    const f = fixture();
    f.interaction.commandName = name;
    let thrown;
    await assert.rejects(command.execute(f.interaction), error => {
      thrown = error;
      return error.context?.dedicatedChannel === 'gambling';
    });
    await handleInteractionError(f.interaction, thrown);
    assert.equal(f.sent.length, 1);
    const payload = f.sent[0].payload;
    assert.equal(payload.embeds[0].toJSON().title, 'Wrong channel');
    assert.equal(payload.embeds[0].toJSON().description,
      `This command can only be used in the dedicated channel. Please use <#${f.gambling.id}> to play.`);
    assert.deepEqual(payload.components, []);
    assert.equal(payload.flags, MessageFlags.Ephemeral);
  });
}

for (const mode of ['editReply', 'followUp', 'prefixReply', 'prefixEdit']) {
  test(`wrong-channel errors have no Close button through ${mode}`, async () => {
    const f = fixture(mode);
    if (mode.startsWith('prefix')) {
      f.interaction._isPrefixCommand = true;
      f.interaction.isChatInputCommand = () => false;
      f.interaction._responseCoordinator = {
        isUsageFinalized: () => false,
        hasResponded: () => mode === 'prefixEdit',
        respond: async payload => f.sent.push({ method: 'prefixReply', payload }),
        edit: async payload => f.sent.push({ method: 'prefixEdit', payload }),
      };
    }
    let thrown;
    await assert.rejects(enforceDedicatedCommandChannel(f.interaction, 'gambling'), error => {
      thrown = error;
      return true;
    });
    await handleInteractionError(f.interaction, thrown);
    assert.equal(f.sent[0].method, mode);
    assert.equal(f.sent[0].payload.embeds[0].toJSON().title, 'Wrong channel');
    assert.deepEqual(f.sent[0].payload.components, []);
  });
}

test('normal validation and shop errors keep their original title and Close button', async () => {
  const f = fixture();
  await handleInteractionError(f.interaction, createError('Bad value', ErrorTypes.VALIDATION, 'Check the value.'));
  assert.equal(f.sent[0].payload.embeds[0].toJSON().title, 'Invalid Input');
  assert.equal(f.sent[0].payload.components[0].toJSON().components[0].label, 'Close');
  let thrown;
  await assert.rejects(enforceDedicatedCommandChannel(f.interaction, 'shop'), error => {
    thrown = error;
    return true;
  });
  await handleInteractionError(f.interaction, thrown);
  assert.equal(f.sent[1].payload.embeds[0].toJSON().title, 'Invalid Input');
  assert.equal(f.sent[1].payload.components.length, 1);
});

test('the gambling channel remains allowed, and other channels do not get sticky messages', async () => {
  const f = fixture();
  f.interaction.channelId = f.gambling.id;
  assert.equal(await enforceDedicatedCommandChannel(f.interaction, 'gambling'), true);
  assert.equal(scheduleDedicatedChannelGuide({ guild: f.guild, channel: f.shop }), false);
  assert.equal(scheduleDedicatedChannelGuide({ channel: f.gambling }), false);
  assert.equal(scheduleDedicatedChannelGuide({
    guild: f.guild, channel: f.gambling, author: f.guild.client.user,
    embeds: [new Embed({ title: 'Gambling & Games' })],
  }), false);
});

test('guide setup uses stored IDs and preserves the current embed and attachments when moving', async t => {
  const storage = new Map();
  t.mock.method(db, 'get', async key => storage.get(key) ?? null);
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, value); return true; });
  const f = fixture();
  f.guild.channels.cache.delete(f.shop.id);
  f.gambling.guild = f.guild;
  f.gambling.client = f.guild.client;
  const embed = new Embed({
    title: 'Gambling & games', description: 'Custom text', color: 0x123456,
    footer: { text: 'Custom footer' }, thumbnail: { url: 'attachment://custom.png' },
  });
  const old = {
    id: '200000000000000001', author: f.guild.client.user, embeds: [embed],
    content: 'Keep this caption',
    attachments: new Collection([['image', { name: 'custom.png', url: 'https://example.com/custom.png' }]]),
    delete: async () => history.delete(old.id),
  };
  const user = { id: '200000000000000002', author: { id: 'user' }, embeds: [] };
  const history = new Collection([[user.id, user], [old.id, old]]);
  f.gambling.lastMessageId = user.id;
  f.gambling.messages = { fetch: async options => options.message
    ? history.get(options.message)
    : new Collection([...history.entries()].sort(([a], [b]) => b.localeCompare(a))) };
  let sentPayload;
  f.gambling.send = async payload => {
    sentPayload = payload;
    const message = {
      id: '200000000000000003', author: f.guild.client.user, embeds: [embed],
      delete: async () => history.delete(message.id),
    };
    f.gambling.lastMessageId = message.id;
    history.set(message.id, message);
    return message;
  };
  const result = await ensureDedicatedChannelGuides({ guilds: { cache: new Collection([[f.guild.id, f.guild]]) } });
  assert.equal(result.find(entry => entry.key === 'gambling').ok, true);
  assert.deepEqual(sentPayload.embeds, [embed.toJSON()]);
  assert.equal(sentPayload.content, 'Keep this caption');
  assert.deepEqual(sentPayload.files, [{ name: 'custom.png', attachment: 'https://example.com/custom.png' }]);
  assert.deepEqual(sentPayload.allowedMentions, { parse: [] });
  assert.equal(history.has(old.id), false);
  assert.equal(storage.get(`cloudy:dedicated-guide:${f.guild.id}:${f.gambling.id}`).messageId,
    f.gambling.lastMessageId);
  let extraSend = false;
  f.gambling.send = async () => { extraSend = true; throw new Error('Already last'); };
  await ensureDedicatedChannelGuides({ guilds: { cache: new Collection([[f.guild.id, f.guild]]) } });
  assert.equal(extraSend, false);
});
