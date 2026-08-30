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
import { createError, ErrorTypes, handleInteractionError, replyUserError } from '../src/utils/errorHandler.js';

function fixture(mode = 'reply') {
  const sent = [];
  const deleted = [];
  const responseMessage = {
    id: 'response-id', deletable: true,
    delete: async () => { deleted.push('response-id'); },
  };
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
  const capture = method => async payload => { sent.push({ method, payload }); return responseMessage; };
  const interaction = {
    id: 'interaction-id', user: { id: 'user-id' }, guild, guildId: guild.id,
    channelId: '100000000000000003',
    createdTimestamp: Date.now(),
    isChatInputCommand: () => true,
    replied: mode === 'followUp', deferred: mode === 'editReply',
    reply: capture('reply'), editReply: capture('editReply'), followUp: capture('followUp'),
    fetchReply: async () => responseMessage,
    deleteReply: async () => { deleted.push('response-id'); },
  };
  return { sent, deleted, responseMessage, interaction, guild, gambling, shop };
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
      'This command can only be used in the dedicated channel. Please use #gambling to play.');
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

const settle = () => new Promise(resolve => { setImmediate(resolve); });

for (const inGambling of [false, true]) {
  for (const mode of ['reply', 'editReply', 'followUp', 'prefixReply', 'prefixEdit']) {
    test(`${mode}: game errors ${inGambling ? 'remain in #gambling' : 'disappear elsewhere after 15 seconds'} without Close`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(mode);
      if (inGambling) f.interaction.channelId = f.gambling.id;
      if (mode.startsWith('prefix')) {
        f.interaction._isPrefixCommand = true;
        f.interaction.isChatInputCommand = () => false;
        f.interaction._responseCoordinator = {
          isUsageFinalized: () => false,
          hasResponded: () => mode === 'prefixEdit',
          getReplyMessage: () => f.responseMessage,
          respond: async payload => { f.sent.push({ method: 'prefixReply', payload }); },
          edit: async payload => { f.sent.push({ method: 'prefixEdit', payload }); },
        };
      }

      let error;
      try {
        await enforceDedicatedCommandChannel(f.interaction, 'gambling');
        error = createError('Game input', ErrorTypes.VALIDATION, 'Check the game input.');
      } catch (caught) {
        error = caught;
      }
      await handleInteractionError(f.interaction, error);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].method, mode);
      assert.deepEqual(f.sent[0].payload.components, []);
      if (inGambling) assert.equal((f.sent[0].payload.flags || 0) & MessageFlags.Ephemeral, 0);

      t.mock.timers.tick(14999);
      await settle();
      assert.deepEqual(f.deleted, []);
      t.mock.timers.tick(1);
      await settle();
      assert.deepEqual(f.deleted, inGambling ? [] : ['response-id']);
      t.mock.timers.tick(60000);
      await settle();
      assert.deepEqual(f.deleted, inGambling ? [] : ['response-id']);
    });
  }
}

for (const useReplyHelper of [false, true]) {
  test(`early cooldown errors in #gambling remain visible through ${useReplyHelper ? 'replyUserError' : 'handleInteractionError'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    f.interaction.commandName = 'roll';
    f.interaction.channelId = f.gambling.id;
    // No command-specific channel guard has run yet.
    if (useReplyHelper) {
      await replyUserError(f.interaction, { type: ErrorTypes.RATE_LIMIT, message: 'Wait before playing again.' });
    } else {
      await handleInteractionError(f.interaction,
        createError('Cooldown', ErrorTypes.RATE_LIMIT, 'Wait before playing again.'));
    }
    assert.deepEqual(f.sent[0].payload.components, []);
    assert.equal((f.sent[0].payload.flags || 0) & MessageFlags.Ephemeral, 0);
    t.mock.timers.tick(60000);
    await settle();
    assert.deepEqual(f.deleted, []);
  });
}

const gameCases = [
  { name: 'gamble win', command: gamble, random: 0 },
  { name: 'gamble loss', command: gamble, random: 0.99 },
  { name: 'fight', command: fight },
  { name: 'fight self', command: fight, opponent: 'self' },
  { name: 'fight bot', command: fight, opponent: 'bot' },
  { name: 'flip', command: flip },
  { name: 'roll', command: roll },
  { name: 'roll invalid input', command: roll, notation: 'invalid', error: true },
  { name: 'gamble insufficient funds', command: gamble, wallet: 0, error: true },
  { name: 'gamble cooldown', command: gamble, cooldown: true, error: true },
];

for (const entry of gameCases) {
  test(`${entry.name} stays in #gambling without a Close button`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    if (entry.random !== undefined) t.mock.method(Math, 'random', () => entry.random);
    const f = fixture();
    f.guild.id = '100000000000000010';
    f.interaction.guildId = f.guild.id;
    f.interaction.user = { id: '100000000000000011', username: 'Player' };
    f.interaction.channelId = f.gambling.id;
    f.interaction.commandName = entry.command.data.name;
    f.interaction.deferReply = async () => { f.interaction.deferred = true; };
    f.interaction.options = {
      getInteger: () => 10,
      getString: () => entry.notation || '2d6+1',
      getUser: () => entry.opponent === 'self'
        ? f.interaction.user
        : { id: '100000000000000012', username: 'Opponent', bot: entry.opponent === 'bot' },
    };
    const writes = [];
    const client = { db: {
      get: async () => ({ wallet: entry.wallet ?? 100, inventory: {}, lastGamble: entry.cooldown ? Date.now() : 0 }),
      set: async (_key, value) => { writes.push(value); return true; },
    } };
    if (entry.error) {
      let error;
      await assert.rejects(entry.command.execute(f.interaction, {}, client), caught => { error = caught; return true; });
      await handleInteractionError(f.interaction, error);
    } else {
      await entry.command.execute(f.interaction, {}, client);
    }
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].payload.components, []);
    assert.equal((f.sent[0].payload.flags || 0) & MessageFlags.Ephemeral, 0);
    if (entry.name === 'gamble win') assert.equal(writes[0].wallet, 110);
    if (entry.name === 'gamble loss') assert.equal(writes[0].wallet, 90);
    t.mock.timers.tick(60000);
    await settle();
    assert.deepEqual(f.deleted, []);
  });
}
