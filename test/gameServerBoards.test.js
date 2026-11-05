import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import {
  OFFLINE_AFTER_MS, POPULATION_WEBHOOK_NAME, buildLeaderboard, buildPopulationBoard, buildStatusBoard,
  resetGameServerBoards,
} from '../src/services/gameServerBoardsService.js';
import { clearGameFeedQueues, postGameFeedEvents } from '../src/services/gameFeedService.js';

const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => { setImmediate(resolve); }); };
// Waits for real I/O (the webhook avatar file) without fixed tick counts.
const until = async check => {
  for (let i = 0; i < 2_000 && !check(); i += 1) await new Promise(resolve => { setImmediate(resolve); });
  assert.ok(check(), 'condition reached');
};

function world() {
  const store = new Map();
  const posts = [];
  const hooks = [];
  let id = 220000000000000000n;
  const channel = name => {
    const messages = new Map();
    const item = {
      id: String(id++), name, type: ChannelType.GuildText, isTextBased: () => true,
      send: async payload => {
        const message = { id: String(id++), payload, edits: [], edit: async next => { message.edits.push(next); return message; } };
        messages.set(message.id, message);
        posts.push({ channel: name, message });
        return message;
      },
      messages: { fetch: async messageId => messages.get(messageId) || Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 })) },
      fetchWebhooks: async () => new Collection(hooks.map(hook => [hook.id, hook])),
      createWebhook: async options => {
        const hookMessages = new Map();
        const hook = {
          id: String(id++), name: options.name, token: 'token', owner: { id: 'cloudy' }, options, sends: [], edits: [],
          send: async payload => { const message = { id: String(id++), payload }; hookMessages.set(message.id, message); hook.sends.push(payload); return message; },
          editMessage: async (messageId, payload) => { hook.edits.push({ messageId, payload }); },
        };
        hooks.push(hook);
        return hook;
      },
    };
    return item;
  };
  const cache = new Collection();
  for (const name of ['📊│server-status', '🌍│population', '🥇│leaderboard', '💀│pvp', '📢│wipe-feed']) {
    const item = channel(name);
    cache.set(item.id, item);
  }
  const guild = { id: '230000000000000000', channels: { cache } };
  const client = {
    user: { id: 'cloudy' }, isReady: () => true, guilds: { cache: new Collection([[guild.id, guild]]) },
    db: { get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; } },
  };
  return { client, posts, hooks };
}

test.beforeEach(() => { resetGameServerBoards(); clearGameFeedQueues(); });

test('status board: online servers with players, queue, map and next wipe; silent servers show offline', () => {
  const now = Date.now();
  const state = { servers: {
    'Server 2 Rust': { online: true, players: 10, max: 100, updatedAt: now - OFFLINE_AFTER_MS - 1 },
    'Server 1 Rust': { online: true, players: 87, max: 150, queue: 3, map: 'Procedural 4000', nextWipe: now + 86_400_000, updatedAt: now },
  }, leaderboard: {}, messages: {} };
  const embed = buildStatusBoard(state, now);
  assert.equal(embed.title, 'Server status');
  assert.match(embed.description, /^<:glowing_dot_green:1567760480439771286> \*\*Server 1 Rust\*\*\nOnline · 87\/150 players · Queue 3\nMap: Procedural 4000 · Next wipe <t:\d+:R>\n\n<:W8733476glowingdotred:1543291468377104436> \*\*Server 2 Rust\*\*\nOffline\n\n\*\*Last update:\*\* <t:\d+:R>$/);
  const population = buildPopulationBoard(state, now);
  assert.equal(population.title, 'Population');
  assert.match(population.description, /\*\*Server 1 Rust\*\*\n<:server_router:1567766741889585203> 87\/150 · Queue 3\n\n\*\*Server 2 Rust\*\*\nOffline\n\n\*\*Total online:\*\* 87$/);
  for (const item of [embed, population]) {
    assert.ok(item.thumbnail.url);
    assert.equal(item.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  }
});

test('leaderboard: most kills first, fewer deaths break a tie, K/D shown', () => {
  const embed = buildLeaderboard({ leaderboard: { 'Server 1 Rust': { since: Date.now(), players: {
    A: { kills: 5, deaths: 2 }, B: { kills: 9, deaths: 0 }, C: { kills: 5, deaths: 1 },
  } } } });
  assert.equal(embed.title, 'Leaderboard');
  assert.match(embed.description, /\*\*1\.\*\* B · 9 kills · 0 deaths · K\/D 9\n\*\*2\.\*\* C · 5 kills · 1 death · K\/D 5\.00\n\*\*3\.\*\* A · 5 kills · 2 deaths · K\/D 2\.50/);
});

test('status events post one board per channel, the population board through the Cloudy Population webhook, then edit in place', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const w = world();
  const result = await postGameFeedEvents(w.client, [
    { type: 'status', server: 'Server 1 Rust', online: true, players: 80, max: 150 },
    { type: 'status', server: 'Server 2 Rust', online: false },
  ]);
  assert.deepEqual(result, { accepted: 2, rejected: [] });
  t.mock.timers.tick(1_000);
  await until(() => w.hooks[0]?.sends.length === 1 && w.posts.some(post => post.channel === '📊│server-status'));
  const status = w.posts.filter(post => post.channel === '📊│server-status');
  assert.equal(status.length, 1);
  assert.match(status[0].message.payload.embeds[0].description, /<:glowing_dot_green:1567760480439771286> \*\*Server 1 Rust\*\*/);
  assert.equal(w.hooks.length, 1);
  assert.equal(w.hooks[0].name, POPULATION_WEBHOOK_NAME);
  assert.ok(Buffer.isBuffer(w.hooks[0].options.avatar), 'still Cloudy logo as avatar');
  assert.equal(w.hooks[0].sends.length, 1);

  // A later update edits the same messages, at most every 30 seconds.
  await postGameFeedEvents(w.client, [{ type: 'status', server: 'Server 1 Rust', online: true, players: 90, max: 150 }]);
  t.mock.timers.tick(29_000);
  await settle();
  assert.equal(status[0].message.edits.length, 0);
  t.mock.timers.tick(2_000);
  await until(() => status[0].message.edits.length > 0 && w.hooks[0].edits.length > 0);
  assert.equal(w.posts.filter(post => post.channel === '📊│server-status').length, 1);
  assert.match(status[0].message.edits.at(-1).embeds[0].description, /90\/150/);
  assert.equal(w.hooks.length, 1);
  assert.equal(w.hooks[0].sends.length, 1);
  assert.match(w.hooks[0].edits.at(-1).payload.embeds[0].description, /90\/150/);
  assert.deepEqual((await postGameFeedEvents(w.client, [{ type: 'status', server: 'S1' }])).rejected,
    [{ index: 0, error: 'online must be true or false' }]);
});

test('kills fill the leaderboard; a finished wipe starts it again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const w = world();
  await postGameFeedEvents(w.client, [
    { type: 'pvp', server: 'Server 1 Rust', killer: 'Dawg', victim: 'Mindzset' },
    { type: 'pvp', server: 'Server 1 Rust', killer: 'Dawg', victim: 'Player456' },
  ]);
  t.mock.timers.tick(1_500);
  await settle();
  const board = w.posts.find(post => post.channel === '🥇│leaderboard').message;
  assert.match(board.payload.embeds[0].description, /\*\*1\.\*\* Dawg · 2 kills · 0 deaths/);
  await postGameFeedEvents(w.client, [{ type: 'wipe', server: 'Server 1 Rust', state: 'done' }]);
  t.mock.timers.tick(31_000);
  await settle();
  assert.match(board.edits.at(-1).embeds[0].description, /\*\*Server 1 Rust\*\*\nNo kills yet\./);
});
