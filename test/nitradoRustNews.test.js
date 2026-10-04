import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType } from 'discord.js';
import { articleLooksLikeRustServerNews, checkForNitradoUpdate, fetchLatestNitradoRustArticle, repairNitradoNewsText } from '../src/events/nitradoPatchNotesReady.js';

const article = (title, slug, date) => ({ node: { title, slug, date, excerpt: '<p>Official server update. You and [&#8230;]</p>' } });
test('Nitrado uses public news API, selects newest Rust update and posts once across repeated checks', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url, /^https:\/\/newsapi\.nitrado\.net\/graphql\?query=/);
    return { ok: true, json: async () => ({ data: { posts: { edges: [
      article('Rust Servers Update', 'rust-servers-update', '2025-01-01T12:00:00Z'),
      article('ARK Update', 'ark-update', '2026-10-01T12:00:00Z'),
      article('Rust vs DayZ Comparison', 'rust-vs-dayz', '2026-09-01T12:00:00Z'),
      article('Rust Modular Vehicles Update', 'rust-modular-vehicles-update', '2026-08-01T12:00:00Z'),
    ] } } }) };
  });
  const latest = await fetchLatestNitradoRustArticle();
  assert.equal(latest.title, 'Rust Modular Vehicles Update');
  assert.equal(latest.description, 'Official server update.');
  const values = new Map(); const sent = [];
  const client = { user: { id: 'bot' }, db: { get: async key => values.get(key), set: async (key, value) => values.set(key, value) }, guilds: { cache: new Collection() } };
  const guild = { id: '1532882647838228723', client, members: { me: {} }, channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) || null } };
  const channel = { id: '1554538638027653260', name: '📰│nitrado', guild, type: ChannelType.GuildText,
    isTextBased: () => true, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => new Collection() },
    send: async payload => { sent.push(payload); } };
  guild.channels.cache.set(channel.id, channel); client.guilds.cache.set(guild.id, guild);
  assert.equal(await checkForNitradoUpdate(client), true);
  assert.equal(await checkForNitradoUpdate(client), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds[0].toJSON().url, latest.link);
});

test('existing Nitrado news loses encoded/truncated text without replacing saved presentation', async () => {
  const data = { title: 'Saved Nitrado title', description: 'Official update. You and [&#8230;]', color: 123, footer: { text: 'Saved footer' }, image: { url: 'https://example.com/image.png' } };
  let changed;
  const message = { id: 'existing', embeds: [{ toJSON: () => data }], edit: async payload => { changed = payload; } };
  assert.equal(await repairNitradoNewsText(message), true);
  assert.deepEqual(changed, { embeds: [{ ...data, description: 'Official update.' }] });
  message.embeds = [{ toJSON: () => ({ ...data, description: 'Official update. You and' }) }];
  assert.equal(await repairNitradoNewsText(message), true);
  assert.equal(changed.embeds[0].description, 'Official update.');
  message.embeds = [{ toJSON: () => changed.embeds[0] }];
  assert.equal(await repairNitradoNewsText(message), false);
});
test('generic homepages and Rust navigation links do not count as Rust updates', () => {
  assert.equal(articleLooksLikeRustServerNews('<meta property="og:title" content="Nitrado Gameserver"><nav>Rust Update</nav>', 'https://server.nitrado.net/en-US/news/rust-update'), false);
  assert.equal(articleLooksLikeRustServerNews('<h1>ARK server update</h1><nav>Rust</nav>', 'https://server.nitrado.net/en-US/news/ark-update'), false);
  assert.equal(articleLooksLikeRustServerNews('<h1>Rust server update</h1>', 'https://server.nitrado.net/en-US/news/rust-update'), true);
});
