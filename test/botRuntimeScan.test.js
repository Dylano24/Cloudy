import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { getCounterCount, getGuildCounterStats } from '../src/services/serverstatsService.js';
import voiceHandler from '../src/events/voiceStateUpdate.js';
import { refreshPlayerMessage } from '../src/services/music/playerHandler.js';
import { getGuildMusicData, deleteGuildMusicData } from '../src/services/music/playerStore.js';
import { getCountingGameConfig, saveCountingGameConfig } from '../src/services/countingGameService.js';
import botConfig from '../src/config/bot.js';
import pay from '../src/commands/Economy/pay.js';
import { getEconomyKey } from '../src/utils/economy.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('total member counter uses the current gateway count without fetching members', async () => {
  const guild = { memberCount: 42, members: { fetch: () => assert.fail('unnecessary member fetch') } };
  assert.equal(await getCounterCount(guild, 'members'), 42);
  guild.memberCount = 0;
  assert.equal(await getCounterCount(guild, 'members'), 0);
});

test('complete member cache gives accurate bot and human counters and follows joins', async () => {
  const cache = new Collection([
    ['bot', { user: { bot: true } }], ['human', { user: { bot: false } }],
  ]);
  const guild = { memberCount: 2, members: { cache, fetch: () => assert.fail('cache is complete') } };
  assert.equal(await getCounterCount(guild, 'bots'), 1);
  assert.equal(await getCounterCount(guild, 'members_only'), 1);
  cache.set('new-human', { user: { bot: false } });
  guild.memberCount = 3;
  assert.equal(await getCounterCount(guild, 'members_only'), 2);
});

test('twenty simultaneous counters share one incomplete member-cache fetch', async () => {
  const gate = deferred();
  let calls = 0;
  const members = new Collection([['bot', { user: { bot: true } }], ['human', { user: { bot: false } }]]);
  const guild = { memberCount: 2, members: { cache: new Collection(), fetch: async () => {
    calls += 1;
    await gate.promise;
    return members;
  } } };
  const requests = Array.from({ length: 20 }, () => getGuildCounterStats(guild));
  gate.resolve();
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.ok(results.every(stats => stats.botCount === 1 && stats.humanCount === 1));
});

test('failed member fetch uses available members and retries on the next request', async () => {
  let calls = 0;
  const cache = new Collection([['bot', { user: { bot: true } }]]);
  const guild = { id: 'retry-counter', memberCount: 3, members: { cache, fetch: async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary member failure');
    return cache;
  } } };
  assert.equal((await getGuildCounterStats(guild)).totalCount, 3);
  await getGuildCounterStats(guild);
  assert.equal(calls, 2);
});

let sequence = 0;
function musicFixture() {
  const guildId = `music-scan-${++sequence}`;
  const channel = { id: 'music-text', messages: { cache: new Collection(), fetch: async () => assert.fail('unexpected fetch') },
    send: async () => assert.fail('unexpected new player message') };
  const player = { current: { info: { title: 'Track', author: 'Artist', length: 60000 } },
    paused: false, playing: true, position: 1000, textChannel: channel.id, queue: [], voiceChannel: 'music-voice' };
  const client = { channels: { cache: new Collection([[channel.id, channel]]) },
    riffy: { players: new Map([[guildId, player]]) }, config: { features: { music: true } } };
  const data = getGuildMusicData(guildId);
  data.playerMessageId = 'player-message';
  data.playerChannelId = channel.id;
  return { guildId, channel, player, client, data };
}

test('music refresh uses the existing cached player message without fetching', async () => {
  const f = musicFixture();
  let edits = 0;
  f.channel.messages.cache.set(f.data.playerMessageId, { edit: async () => { edits += 1; } });
  await refreshPlayerMessage(f.client, f.guildId);
  assert.equal(edits, 1);
  deleteGuildMusicData(f.guildId);
});

test('twenty concurrent player refreshes coalesce into two edits and keep latest controls', async () => {
  const f = musicFixture();
  const gate = deferred();
  const payloads = [];
  let active = 0;
  let peak = 0;
  f.channel.messages.cache.set(f.data.playerMessageId, { edit: async payload => {
    active += 1;
    peak = Math.max(peak, active);
    payloads.push(payload);
    if (payloads.length === 1) await gate.promise;
    active -= 1;
  } });
  const requests = Array.from({ length: 20 }, () => refreshPlayerMessage(f.client, f.guildId));
  f.player.paused = true;
  gate.resolve();
  await Promise.all(requests);
  assert.equal(payloads.length, 2);
  assert.equal(peak, 1);
  assert.equal(payloads.at(-1).components[0].toJSON().components[0].disabled, true);
  deleteGuildMusicData(f.guildId);
});

test('temporary fetch and permission failures preserve the player target and never post duplicates', async () => {
  for (const code of [50013, 'ECONNRESET']) {
    const f = musicFixture();
    let fetches = 0;
    let edits = 0;
    f.channel.messages.fetch = async () => {
      fetches += 1;
      if (fetches === 1) throw Object.assign(new Error('temporary Discord failure'), { code });
      return { edit: async () => { edits += 1; } };
    };
    await refreshPlayerMessage(f.client, f.guildId);
    assert.equal(f.data.playerMessageId, 'player-message');
    await refreshPlayerMessage(f.client, f.guildId);
    assert.equal(fetches, 2);
    assert.equal(edits, 1);
    deleteGuildMusicData(f.guildId);
  }
});

test('Discord-confirmed deleted player message is replaced once', async () => {
  const f = musicFixture();
  let sends = 0;
  f.channel.messages.fetch = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  f.channel.send = async () => { sends += 1; return { id: 'replacement-player' }; };
  await refreshPlayerMessage(f.client, f.guildId);
  assert.equal(sends, 1);
  assert.equal(f.data.playerMessageId, 'replacement-player');
  deleteGuildMusicData(f.guildId);
});

test('unchanged voice membership skips Join to Create storage while music auto-pause still works', async () => {
  const f = musicFixture();
  const voice = { id: 'music-voice', members: new Collection() };
  f.client.channels.cache.set(voice.id, voice);
  f.client.db = { get: () => assert.fail('mute/deafen must not read Join to Create settings') };
  f.channel.messages.cache.set(f.data.playerMessageId, { edit: async () => {} });
  let pauses = 0;
  f.player.pause = value => { f.player.paused = value; pauses += 1; };
  const guild = { id: f.guildId };
  const member = { id: 'voice-user', user: { bot: false } };
  const state = { guild, member, channel: voice };
  await voiceHandler.execute({ ...state, selfMute: false }, { ...state, selfMute: true }, f.client);
  assert.equal(pauses, 1);
  assert.equal(f.data.autoPaused, true);
  await refreshPlayerMessage(f.client, f.guildId);
  deleteGuildMusicData(f.guildId);
});

test('failed counting-game save rejects and keeps the last persisted cache', async () => {
  const guildId = 'failed-counting-save';
  const client = { db: { get: async () => ({ enabled: true, nextNumber: 7 }), set: async () => false } };
  await getCountingGameConfig(client, guildId);
  await assert.rejects(saveCountingGameConfig(client, guildId, { enabled: false, nextNumber: 1 }), /not persisted/);
  assert.equal((await getCountingGameConfig(client, guildId)).nextNumber, 7);
});

test('XP and leveling remain disabled', () => {
  assert.equal(botConfig.features.leveling, false);
});

function paymentFixture({ amount = 10, writeFails = false } = {}) {
  const guildId = '1532882647838228723';
  const senderId = '1532882647838228724';
  const receiverId = '1532882647838228725';
  const values = new Map([
    [getEconomyKey(guildId, senderId), { wallet: 50, bank: 8 }],
    [getEconomyKey(guildId, receiverId), { wallet: 20, bank: 12 }],
  ]);
  const replies = [];
  const dms = [];
  let reads = 0;
  const receiver = { id: receiverId, username: 'Receiver', tag: 'Receiver', bot: false,
    displayAvatarURL: () => 'https://example.com/avatar.png', send: async payload => { dms.push(payload); } };
  const interaction = { id: 'payment-scan', guildId, user: { id: senderId, username: 'Sender' }, deferred: true,
    createdTimestamp: Date.now(), isChatInputCommand: () => true,
    options: { getUser: () => receiver, getInteger: () => amount },
    editReply: async payload => { replies.push(payload); } };
  const client = { db: { get: async key => { reads += 1; return structuredClone(values.get(key)); },
    set: async (key, value) => { if (writeFails) return false; values.set(key, structuredClone(value)); return true; } } };
  return { client, interaction, replies, dms, reads: () => reads, sender: () => values.get(getEconomyKey(guildId, senderId)),
    receiver: () => values.get(getEconomyKey(guildId, receiverId)) };
}

test('payment uses two account reads and displays the committed balances unchanged', async () => {
  const f = paymentFixture();
  await pay.execute(f.interaction, {}, f.client);
  assert.equal(f.reads(), 2);
  assert.equal(f.sender().wallet, 40);
  assert.equal(f.receiver().wallet, 30);
  assert.equal(f.sender().bank, 8);
  assert.equal(f.receiver().bank, 12);
  assert.equal(f.replies[0].embeds[0].toJSON().fields.find(field => field.name === 'Your New Balance').value, '$40');
  assert.equal(f.dms[0].embeds[0].toJSON().fields[0].value, '$30');
});

test('payment still rejects insufficient cash without posting success', async () => {
  const f = paymentFixture({ amount: 100 });
  await assert.rejects(pay.execute(f.interaction, {}, f.client));
  assert.equal(f.sender().wallet, 50);
  assert.equal(f.replies.length + f.dms.length, 0);
});

test('payment never acknowledges or sends a DM for a failed database write', async () => {
  const f = paymentFixture({ writeFails: true });
  await assert.rejects(pay.execute(f.interaction, {}, f.client));
  assert.equal(f.sender().wallet, 50);
  assert.equal(f.replies.length + f.dms.length, 0);
});
