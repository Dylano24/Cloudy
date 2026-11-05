import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import {
  CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, SAMPLE_GAME_FEED_EVENTS, buildGameFeedEmbed, clearGameFeedQueues,
  normalizeGameFeedEvent, postGameFeedEvents,
} from '../src/services/gameFeedService.js';
import { createGameFeedHandler } from '../src/web/gameFeedApi.js';
import gamefeed from '../src/commands/GameServer/gamefeed.js';

const SECRET = 'g'.repeat(40);
const settle = () => new Promise(resolve => { setImmediate(resolve); });

function world({ missing = [] } = {}) {
  const sent = [];
  const cache = new Collection();
  let id = 180000000000000000n;
  for (const name of ['💀│pvp', '👤│player', '🛡️│zorp', '💣│raids', '🔨│ban', '📢│wipe-feed', '💬│general']) {
    if (missing.some(entry => name.endsWith(entry))) continue;
    const channel = {
      id: String(id++), name, type: ChannelType.GuildText, isTextBased: () => true,
      send: async payload => { sent.push({ channel: name, payload }); return { id: 'm' + sent.length }; },
    };
    cache.set(channel.id, channel);
  }
  const guild = { id: '181818181818181818', channels: { cache } };
  const store = new Map();
  const client = { isReady: () => true, guilds: { cache: new Collection([[guild.id, guild]]) },
    db: { get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; } } };
  return { client, guild, sent, store };
}

test.afterEach(() => clearGameFeedQueues());

test('every feed embed has a sentence-case title, the Cloudy logo, the footer and its own colour', () => {
  const embeds = SAMPLE_GAME_FEED_EVENTS.map(event => buildGameFeedEmbed(normalizeGameFeedEvent(event)));
  assert.deepEqual(embeds.map(embed => embed.title), [
    'Player killed', 'Player joined', 'Player left', 'ZORP protection on', 'ZORP protection off',
    'Raid alert', 'Player banned', 'Player unbanned', 'Wipe incoming', 'Server wiped',
  ]);
  for (const embed of embeds) {
    assert.deepEqual(embed.thumbnail, { url: CLOUDY_C_LOGO_URL });
    assert.equal(embed.footer.text, CLOUDY_FOOTER);
    assert.match(embed.description, /\*\*Time:\*\* <t:\d+:f>$/);
  }
  assert.deepEqual(embeds.map(embed => embed.color.toString(16)),
    ['ffffff', 'c49d', 'ffffff', 'c49d', '7a1712', '7a1712', '7a1712', 'c49d', 'ffffff', 'c49d']);
  assert.match(embeds[0].description, /^\*\*Killer:\*\* Dawg\n\*\*Victim:\*\* Mindzset\n\*\*Weapon:\*\* Assault rifle\n\*\*Distance:\*\* 145 m\n\*\*Headshot:\*\* Yes\n\*\*Grid:\*\* G12\n\*\*Server:\*\* Server 1 Rust\n/);
  assert.match(embeds[1].description, /\*\*Online:\*\* 87\/150/);
  assert.match(embeds[8].description, /^\*\*Server 1 Rust\*\* is about to wipe <t:\d+:R>\.\n\n\*\*Wipe:\*\* Map wipe/);
  assert.match(embeds[9].description, /^\*\*Server 1 Rust\*\* just wiped\.\n\n/);
});

test('events are checked: unknown types, missing names and game-server markup never reach Discord', () => {
  assert.throws(() => normalizeGameFeedEvent({ type: 'nuke', server: 'S1' }), /unknown type/);
  assert.throws(() => normalizeGameFeedEvent({ type: 'pvp', server: 'S1', killer: 'A' }), /victim is required/);
  assert.throws(() => normalizeGameFeedEvent({ type: 'player', server: 'S1', player: 'A', action: 'dance' }), /join or leave/);
  const clean = normalizeGameFeedEvent({ type: 'pvp', server: 'S1', killer: '@everyone <@1>', victim: '**bold**', distance: 'far' });
  assert.equal(clean.killer, 'everyone 1');
  assert.equal(clean.victim, 'bold');
  assert.equal(clean.distance, null);
});

test('events are posted per channel, up to 10 embeds per message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world();
  const pvp = Array.from({ length: 12 }, (_, n) => ({ type: 'pvp', server: 'S1', killer: 'A' + n, victim: 'B' }));
  const result = await postGameFeedEvents(w.client, [...pvp, { type: 'zorp', server: 'S1', state: 'on', player: 'Dawg' }, { type: 'bad' }]);
  assert.equal(result.accepted, 13);
  assert.deepEqual(result.rejected, [{ index: 13, error: 'unknown type bad' }]);
  await settle();
  assert.equal(w.sent.length, 1, 'a full batch of 10 goes at once');
  t.mock.timers.tick(1_500);
  await settle();
  assert.deepEqual(w.sent.map(entry => [entry.channel, entry.payload.embeds.length]),
    [['💀│pvp', 10], ['💀│pvp', 2], ['🛡️│zorp', 1]]);
  assert.ok(w.sent.every(entry => entry.payload.allowedMentions.parse.length === 0));
});

test('a missing feed channel rejects only its own events', async () => {
  const w = world({ missing: ['raids'] });
  const result = await postGameFeedEvents(w.client, [{ type: 'raid', server: 'S1', attacker: 'A' }]);
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.rejected, [{ index: 0, error: '#raids channel not found' }]);
});

function call(handler, { token, body }) {
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  return handler({ headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res).then(() => res);
}

test('the link point stays closed until the game server is linked, and needs the secret', async () => {
  const w = world();
  const notLinked = createGameFeedHandler({ client: w.client, env: {} });
  assert.equal((await call(notLinked, { token: SECRET, body: { events: [] } })).statusCode, 503);
  const handler = createGameFeedHandler({ client: w.client, env: { CLOUDY_GAME_FEED_SECRET: SECRET } });
  assert.equal((await call(handler, { token: 'wrong', body: { events: [] } })).statusCode, 401);
  assert.equal((await call(handler, { body: { events: [] } })).statusCode, 401);
  assert.equal((await call(handler, { token: SECRET, body: {} })).statusCode, 400);
  assert.equal((await call(handler, { token: SECRET, body: { events: Array(51).fill({}) } })).statusCode, 413);
  const ok = await call(handler, { token: SECRET, body: { events: [{ type: 'ban', server: 'S1', player: 'Cheater' }] } });
  assert.equal(ok.statusCode, 202);
  assert.deepEqual(ok.body, { accepted: 1, rejected: [] });
  const single = await call(handler, { token: SECRET, body: { type: 'wipe', server: 'S1', state: 'done' } });
  assert.equal(single.statusCode, 202);
});

test('/gamefeed preview shows every feed embed privately; status lists the channels and the link', async () => {
  const w = world({ missing: ['wipe-feed'] });
  const reply = sub => {
    const interaction = { client: w.client, guild: w.guild, options: { getSubcommand: () => sub },
      reply: async payload => { interaction.payload = payload; }, followUp: async payload => { interaction.boards = payload; } };
    return gamefeed.execute(interaction).then(() => Object.assign(interaction.payload, { boards: interaction.boards }));
  };
  assert.equal(gamefeed.data.toJSON().name, 'gamefeed');
  const preview = await reply('preview');
  assert.equal(preview.flags, 64);
  assert.equal(preview.embeds.length, 10);
  assert.deepEqual(preview.boards.embeds.map(embed => embed.title), ['Server status', 'Population', 'Leaderboard']);
  assert.equal(preview.boards.flags, 64);
  const status = await reply('status');
  assert.equal(status.embeds[0].title, 'Game server feeds');
  assert.match(status.embeds[0].description, /\*\*#pvp:\*\* <#\d+>/);
  assert.match(status.embeds[0].description, /\*\*#wipe-feed:\*\* Not found/);
  assert.match(status.embeds[0].description, /\*\*Game server link:\*\* Not linked yet/);
});

test('the owner\'s feed channel IDs win over channel names', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world();
  const sent = [];
  const ids = { kills: '1555124201688670269', players: '1555124202825191516', zorp: '1555124204008116274', raids: '1555124205391970395', bans: '1555124206495207445' };
  for (const [name, id] of Object.entries(ids)) {
    w.guild.channels.cache.set(id, { id, name: `renamed-${name}`, type: ChannelType.GuildText, isTextBased: () => true,
      send: async payload => { sent.push({ id, payload }); return { id: 'm' }; } });
  }
  await postGameFeedEvents(w.client, [
    { type: 'pvp', server: 'S1', killer: 'A', victim: 'B' },
    { type: 'player', server: 'S1', action: 'join', player: 'A' },
    { type: 'zorp', server: 'S1', state: 'on', player: 'A' },
    { type: 'raid', server: 'S1', attacker: 'A' },
    { type: 'ban', server: 'S1', player: 'A' },
  ]);
  t.mock.timers.tick(1_500);
  await settle();
  assert.deepEqual(sent.map(entry => entry.id).sort(), Object.values(ids).sort());
  assert.equal(w.sent.length, 0, 'the channels found by name are not used');
});
