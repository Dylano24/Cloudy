import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import mapvote from '../src/commands/Tools/mapvote.js';
import { buildVoteMessage, loadVote } from '../src/services/voteService.js';
import { featuredMaps, parseMapInput, resolveMap } from '../src/services/rustMapsService.js';

const json = value => value?.toJSON?.() || value;
const ID = n => String(n).repeat(32).slice(0, 32);

const FRONT = [1, 2, 3, 4].map(n => `{\\"mapId\\":\\"${ID(n)}\\",\\"displayName\\":null,\\"url\\":\\"/map/3700_${100 + n}\\",\\"seed\\":${100 + n},\\"size\\":3700,\\"thumbnailUrl\\":\\"https://content.rustmaps.com/maps/289/${ID(n)}/thumbnail.webp\\"}`).join(',');
const fakeFetch = async (url, options = {}) => {
  if (options.method === 'HEAD') return { ok: !url.includes(ID(4)) };
  if (url === 'https://rustmaps.com/') return { ok: true, text: async () => FRONT };
  if (url === 'https://rustmaps.com/map/3700_555') return { ok: true, text: async () => `x https://content.rustmaps.com/maps/289/${ID(9)}/thumbnail.webp` };
  return { ok: false, status: 404, text: async () => '' };
};

test('map input: link or size_seed only', () => {
  assert.deepEqual(parseMapInput('https://rustmaps.com/map/3700_1106429558'), { size: 3700, seed: 1106429558 });
  assert.deepEqual(parseMapInput('4250_77'), { size: 4250, seed: 77 });
  assert.equal(parseMapInput('map one'), null);
  assert.equal(parseMapInput('https://evil.example/map/3700_1'), null);
});

test('maps come from the front page of rustmaps.com, skipping pictures that do not exist', async () => {
  const maps = await featuredMaps(3, { fetchImpl: fakeFetch, random: () => 0 });
  assert.equal(maps.length, 3);
  assert.ok(maps.every(map => map.image.startsWith('https://content.rustmaps.com/maps/289/') && map.image.endsWith('/map_icons.png')));
  assert.ok(!maps.some(map => map.mapId === ID(4)));
  const one = await resolveMap('3700_555', { fetchImpl: fakeFetch });
  assert.equal(one.mapId, ID(9));
  assert.equal(one.pageUrl, 'https://rustmaps.com/map/3700_555');
  await assert.rejects(resolveMap('3700_556', { fetchImpl: fakeFetch }), /was not found|answered 404/);
});

test('the map vote shows three small pictures in one embed and numbered buttons', async () => {
  const store = new Map();
  const sent = [];
  const channel = { id: 'c', send: async payload => { const message = { id: '31', ...payload }; sent.push(message); return message; } };
  const client = { guilds: { cache: new Collection() }, db: {
    get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    set: async (key, value) => { store.set(key, structuredClone(value)); return true; } } };
  const values = { map1: '3700_555' };
  const interaction = { client, guildId: 'g', channelId: 'c', channel, user: { id: 'u' }, inGuild: () => true,
    options: { getString: name => values[name] ?? null }, deferReply: async () => {}, editReply: async payload => { interaction.reply = payload; }, deleteReply: async () => {} };
  await mapvote.execute(interaction, {
    resolveMap: input => resolveMap(input, { fetchImpl: fakeFetch }),
    featuredMaps: (count, options) => featuredMaps(count, { ...options, fetchImpl: fakeFetch, random: () => 0 }),
  });
  const message = sent[0];
  assert.equal(message.embeds.length, 3);
  assert.equal(message.embeds[0].title, '🗳️ Map vote');
  assert.ok(new Set(message.embeds.map(embed => embed.url)).size === 1, 'same url: Discord shows one embed');
  assert.ok(message.embeds.every(embed => embed.image.url.endsWith('/map_icons.png')));
  assert.match(message.embeds[0].description, /\*\*\[Map 1\]\(https:\/\/rustmaps\.com\/map\/3700_555\)\*\* · Size 3700 · Seed 555\n▱{6} \*\*0%\*\*/);
  assert.deepEqual(json(message.components[0]).components.map(button => button.emoji?.name), ['1️⃣', '2️⃣', '3️⃣']);
  assert.equal((await loadVote(client, 'g', '31')).images.length, 3);
  assert.equal(buildVoteMessage({ ...(await loadVote(client, 'g', '31')), ended: true }).embeds[0].title, '🗳️ Map vote ended');
});
