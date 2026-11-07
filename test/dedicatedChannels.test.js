import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed, MessageFlags } from 'discord.js';
import { db } from '../src/utils/database.js';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';

// Exercise the same channel wrappers as the deployed command registry.
before(async () => { await loadCommands({}); });
import gamble from '../src/commands/Economy/gambling.js';
import games from '../src/commands/Economy/games.js';
import shopCommand from '../src/commands/Economy/shop.js';
import buy from '../src/commands/Economy/buy.js';
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

for (const [name, command] of Object.entries({ gamble, game: games })) {
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

for (const [name, command] of Object.entries({ shop: shopCommand, buy })) {
  test(`/${name} rejects the wrong channel before shop logic and uses the same flow as gambling`, async () => {
    const f = fixture();
    f.interaction.commandName = name;
    let thrown;
    await assert.rejects(command.execute(f.interaction), error => {
      thrown = error;
      return error.context?.dedicatedChannel === 'shop';
    });
    await handleInteractionError(f.interaction, thrown);
    assert.equal(f.sent.length, 1);
    const payload = f.sent[0].payload;
    assert.equal(payload.embeds[0].toJSON().title, 'Wrong channel');
    assert.equal(payload.embeds[0].toJSON().description,
      `This command can only be used in the dedicated channel. Please use <#${f.shop.id}> for your purchases.`);
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

test('auto-deleting validation and wrong-channel errors have no Close button', async () => {
  const f = fixture();
  await handleInteractionError(f.interaction, createError('Bad value', ErrorTypes.VALIDATION, 'Check the value.'));
  assert.equal(f.sent[0].payload.embeds[0].toJSON().title, 'Invalid input');
  assert.deepEqual(f.sent[0].payload.components, []);
  let thrown;
  await assert.rejects(enforceDedicatedCommandChannel(f.interaction, 'shop'), error => {
    thrown = error;
    return true;
  });
  await handleInteractionError(f.interaction, thrown);
  assert.equal(f.sent[1].payload.embeds[0].toJSON().title, 'Wrong channel');
  assert.equal(f.sent[1].payload.embeds[0].toJSON().description,
    `This command can only be used in the dedicated channel. Please use <#${f.shop.id}> for your purchases.`);
  assert.deepEqual(f.sent[1].payload.components, []);
  assert.equal(f.sent[1].payload.flags, MessageFlags.Ephemeral);
});

test('gambling and shop schedule their sticky guides while unrelated channels do not', async () => {
  const f = fixture();
  f.interaction.channelId = f.gambling.id;
  assert.equal(await enforceDedicatedCommandChannel(f.interaction, 'gambling'), true);
  assert.equal(scheduleDedicatedChannelGuide({ guild: f.guild, channel: f.shop }), true);
  assert.equal(scheduleDedicatedChannelGuide({ guild: f.guild, channel: { id: '100000000000000003', name: 'general' } }), false);
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
    title: 'Games & Economy', description: 'Custom text', color: 0x123456,
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
      components: [{ components: [{ customId: 'dedicated_commands:gambling' }] }],
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
    test(`${mode}: game errors ${inGambling ? 'remain in #gambling' : 'disappear elsewhere after 10 seconds'} without Close`, async t => {
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

      t.mock.timers.tick(9999);
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
    f.interaction.commandName = 'blackjack';
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

for (const command of [gamble, games]) {
  test(`/${command.data.name} keeps its current information panel in #gambling`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    f.interaction.channelId = f.gambling.id;
    f.interaction.commandName = command.data.name;
    await command.execute(f.interaction);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].payload.components, []);
    assert.equal((f.sent[0].payload.flags || 0) & MessageFlags.Ephemeral, 0);
    const content = JSON.stringify(f.sent[0].payload);
    for (const name of ['blackjack', 'baccarat', 'roulette']) assert.match(content, new RegExp('/' + name));
    assert.doesNotMatch(content, /\/(?:fish|mine|flip|roll|fight|slut)\b/);
    t.mock.timers.tick(60000);
    await settle();
    assert.deepEqual(f.deleted, []);
  });
}

for (const commandName of ['balance', 'deposit', 'withdraw', 'pay', 'inventory', 'leaderboard']) {
  test(`${commandName} works in gambling and shop and mentions both elsewhere`, async () => {
    const f = fixture();
    f.interaction.commandName = commandName;
    for (const channel of [f.gambling, f.shop]) {
      f.interaction.channelId = channel.id;
      assert.equal(await enforceDedicatedCommandChannel(f.interaction, 'gambling'), true);
    }
    f.interaction.channelId = 'general';
    await assert.rejects(enforceDedicatedCommandChannel(f.interaction, 'gambling'), error => {
      assert.equal(error.userMessage, `This command can only be used in the dedicated channel. Please use <#${f.gambling.id}> or <#${f.shop.id}> to use economy commands.`);
      return true;
    });
  });
}
for (const commandName of ['beg', 'crime', 'daily', 'rob', 'work']) {
  test(`${commandName} stays gambling only with earn money guidance`, async () => {
    const f = fixture();
    f.interaction.commandName = commandName;
    f.interaction.channelId = f.shop.id;
    await assert.rejects(enforceDedicatedCommandChannel(f.interaction, 'gambling'), error => {
      assert.equal(error.userMessage, `This command can only be used in the dedicated channel. Please use <#${f.gambling.id}> to earn money.`);
      return true;
    });
  });
}

test('the Gambling and Shop guides move to the bottom every 2 messages', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/services/dedicatedChannelService.js', 'utf8');
  assert.match(source, /guideManager\('gambling', isGamblingGuide, 2\)/);
  assert.match(source, /guideManager\('shop', isShopGuide, 2\)/);
});
