import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import {
  CLOUDY_C_LOGO_URL, CLOUDY_FOOTER, SAMPLE_GAME_FEED_EVENTS, buildGameFeedEmbed, clearGameFeedQueues,
  normalizeGameFeedEvent, postGameFeedEvents,
} from '../src/services/gameFeedService.js';
import { createGameFeedHandler } from '../src/web/gameFeedApi.js';
import gamefeed from '../src/commands/GameServer/gamefeed.js';
import { isGameFeedEmbed } from '../src/services/gameFeedTitles.js';

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

test('classic feed embeds with names in code, big logo, footer with small logo and Time', () => {
  const embeds = SAMPLE_GAME_FEED_EVENTS.map(event => buildGameFeedEmbed({ ...normalizeGameFeedEvent(event), streak: event.streak, protectedFor: event.protectedFor }));
  assert.deepEqual(embeds.map(embed => embed.title.replace(/^<a?:\w+:\d+> /, '')), [
    'Kill feed', 'LOGIN', 'LOGOUT', 'Kit claimed',
    'ZORP', 'ZORP', 'Raid alert', 'BAN', 'UNBAN', 'Server wiped',
  ]);
  // Player killed (owner's choice): "Kill feed", then one code box with killer, skull, victim and streak (standard emoji only), then icon and value per line.
  assert.match(embeds[0].description, /^`Dyn 💀 Dylano 🔥 3`\n<a:cloudy_rifle:\d+> Assault rifle\n<a:cloudy_distance:\d+> 145 m\n<a?:server_router:\d+> Darkzone South\n<:W87205667glowingdotwhite:\d+> <t:\d+:f>$/);
  assert.doesNotMatch(embeds[0].description, /:\*\*/, 'no labels with colons');
  assert.equal(isGameFeedEmbed(embeds[0]), true, 'still skipped by every response-template layer');
  assert.match(embeds[1].description, /^\*\*Player:\*\* `Dylano`\n\*\*Platform:\*\* <:whitexboxlogominimal:\d+>\n/);
  assert.match(embeds[2].description, /\*\*Platform:\*\* <:\w*console\w*:\d+>\n/);
  assert.match(embeds[3].description, /\*\*Kit:\*\* Full Kit AK/);
  assert.match(embeds[5].description, /\*\*Protected for:\*\* 2h 14m/);
  assert.match(embeds[9].description, /^\*\*Darkzone South\*\* has just wiped!\n\n<:W87205667glowingdotwhite:\d+> \*\*Wipe:\*\* Map wipe\n<:W87205667glowingdotwhite:\d+> \*\*Map:\*\* Procedural 4000\n\n\*\*How to play on this server\?\*\*\n-# \u200b\n<:W87205667glowingdotwhite:\d+> Open the community tab in Rust\n<:W87205667glowingdotwhite:\d+> Search for `Darkzone South`\n\n\*\*Current wipe\*\*\n-# \u200b\n<:W87205667glowingdotwhite:\d+> \*\*Start:\*\* <t:\d+:s>\n<:W87205667glowingdotwhite:\d+> \*\*End:\*\* <t:\d+:s>\n<:W87205667glowingdotwhite:\d+> \*\*Time:\*\*/);
  for (const embed of embeds) {
    assert.equal(embed.thumbnail.url, CLOUDY_C_LOGO_URL);
    assert.deepEqual(embed.footer, { text: CLOUDY_FOOTER });
    assert.equal(embed.timestamp, undefined);
  }
  assert.deepEqual(embeds.map(embed => embed.color.toString(16)),
    ['7a1712', 'c49d', '7a1712', 'ffffff', 'c49d', '7a1712', '7a1712', '7a1712', 'c49d', 'ffffff']);
});

test('killstreak and ZORP protection time are tracked per server', async () => {
  const { enrichGameFeedEvent } = await import('../src/services/gameFeedService.js');
  const kill = (killer, victim) => enrichGameFeedEvent(normalizeGameFeedEvent({ type: 'pvp', server: 'Track', killer, victim }));
  enrichGameFeedEvent(normalizeGameFeedEvent({ type: 'wipe', server: 'Track', state: 'done' }));
  assert.equal(kill('A', 'B').streak, 1);
  assert.equal(kill('A', 'C').streak, 2);
  assert.equal(kill('C', 'A').streak, 1);
  assert.equal(kill('A', 'B').streak, 1, 'a death ends the streak');
  enrichGameFeedEvent(normalizeGameFeedEvent({ type: 'zorp', server: 'Track', state: 'on', player: 'Z', time: 1_000_000_000_000 }));
  const off = enrichGameFeedEvent(normalizeGameFeedEvent({ type: 'zorp', server: 'Track', state: 'off', player: 'Z', time: 1_000_000_000_000 + 3_600_000 }));
  assert.equal(off.protectedFor, 3_600_000);
});

test('events are checked: unknown types, missing names and game-server markup never reach Discord', () => {
  assert.throws(() => normalizeGameFeedEvent({ type: 'nuke', server: 'S1' }), /unknown type/);
  assert.throws(() => normalizeGameFeedEvent({ type: 'pvp', server: 'S1', killer: 'A' }), /victim is required/);
  assert.throws(() => normalizeGameFeedEvent({ type: 'player', server: 'S1', player: 'A', action: 'dance' }), /join, leave or kit/);
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

test('/gamefeed embeds shows every feed embed privately; status lists the channels and the link', async () => {
  const w = world({ missing: ['wipe-feed'] });
  const reply = sub => {
    const interaction = { client: w.client, guild: w.guild, options: { getSubcommand: () => sub },
      reply: async payload => { interaction.payload = payload; }, followUp: async payload => { interaction.boards = payload; } };
    return gamefeed.execute(interaction).then(() => Object.assign(interaction.payload, { boards: interaction.boards }));
  };
  assert.equal(gamefeed.data.toJSON().name, 'gamefeed');
  const preview = await reply('embeds');
  assert.equal(preview.flags, 64);
  assert.equal(preview.embeds.length, 10);
  assert.deepEqual(preview.boards.embeds.map(embed => embed.title), ['Server status', 'Population', 'Leaderboard', 'Top killers of the day']);
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

test('the weapon in an event gets its Rust emoji; unknown weapons keep the general one', async () => {
  const { weaponEmoji } = await import('../src/services/feedEmojiService.js');
  const id = text => weaponEmoji(text).match(/rust_(\w+):/)?.[1];
  assert.equal(id('Assault Rifle'), 'ak');
  assert.equal(id('AK-47'), 'ak');
  assert.equal(id('MP5A4'), 'mp5');
  assert.equal(id('Custom SMG'), 'smg');
  assert.equal(id('Thompson'), 'thompson');
  assert.equal(id('Jackhammer'), 'jackhammer');
  assert.equal(id('Pickaxe'), 'pickaxe');
  assert.equal(id('Rocket'), 'rocket');
  assert.equal(id('Semi-Automatic Rifle'), 'sar');
  assert.equal(id('Timed Explosive Charge'), 'c4');
  assert.equal(weaponEmoji('Spoon'), '');
  const unknown = buildGameFeedEmbed({ ...normalizeGameFeedEvent({ type: 'pvp', server: 'S', killer: 'A', victim: 'B', weapon: 'Spoon' }) });
  // A kill shows the owner's rifle icon before every weapon (owner's choice); raids keep the weapon's own emoji.
  assert.match(unknown.description, /\n<a:cloudy_rifle:\d+> Spoon\n/);
  const raid = buildGameFeedEmbed({ ...normalizeGameFeedEvent({ type: 'raid', server: 'S', attacker: 'A', item: 'Rocket' }) });
  assert.match(raid.description, /\*\*Used:\*\* <:rust_rocket:\d+> Rocket/);
});

test('ban log: emoji lines without labels, tags the player and staff, relative times', () => {
  const ban = buildGameFeedEmbed(normalizeGameFeedEvent({ type: 'ban', server: 'S1', action: 'ban', player: 'nathanwh3344',
    discord: '132048835679420418', byDiscord: '155555555555555555', reason: 'Raid in a red zone', expiresAt: 1_900_000_000_000, time: 1_800_000_000_000 }));
  const lines = ban.description.split('\n');
  assert.deepEqual(lines.map(text => text.match(/^<a?:(\w+):\d+>|^\S+/)[1] || 'staff'),
    ['log_link', 'log_rust', 'log_reason', 'server_router']);
  assert.deepEqual(lines.map(text => text.replace(/^(?:<a?:\w+:\d+>|\S+) /, '')), [
    '<@132048835679420418>', '`nathanwh3344`', 'Raid in a red zone', 'S1',
  ]);
  assert.ok(lines.every(text => !/\*\*\w+:\*\*/.test(text)), 'no labels');
  assert.match(ban.title, /BAN$/);
  assert.equal(ban.footer.text, CLOUDY_FOOTER);
  const unban = buildGameFeedEmbed(normalizeGameFeedEvent({ type: 'ban', server: 'S1', action: 'unban', player: 'x', by: 'Staff', bannedAt: 1_700_000_000_000, time: 1_800_000_000_000 }));
  assert.deepEqual(unban.description.split('\n').map(text => text.replace(/^(?:<a?:\w+:\d+>|\S+) /, '')), [
    '`x`', 'S1',
  ]);
  const permanent = buildGameFeedEmbed(normalizeGameFeedEvent({ type: 'ban', server: 'S1', player: 'y', discord: 'not-an-id' }));
  assert.doesNotMatch(permanent.description, /<t:/, 'no time lines');
  assert.doesNotMatch(permanent.description, /<@/);
});
