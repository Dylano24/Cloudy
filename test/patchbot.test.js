import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { MODULES } from '../src/web/dashboardApi.js';
import { deliverPatchbotUpdates, normalizePatchbotConfig } from '../src/services/patchbotService.js';

const CHANNEL = '161616161616161616';
const ROLE = '171717171717171717';
const RUST_CHANNEL = '1533886914459861103';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const patch = (n = 1) => ({
  title: `Rust update ${n}`, link: `https://rust.facepunch.com/news/update-${n}`, description: 'Patch text',
  body: 'Patch text', image: 'https://files.facepunch.com/banner.png', publishedAt: 'Thu, 05 Nov 2026 18:00:00 GMT',
});

// The guild config is cached per server, so each test uses its own server.
let nextGuild = 151515151515151515n;
function world() {
  const GUILD = String(nextGuild++);
  const store = new Map();
  const sent = [];
  const channel = (id, name) => ({
    id, name, type: 0, isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection() },
    send: async payload => { sent.push({ channelId: id, payload }); return { id: 'm' + sent.length }; },
  });
  const channels = new Map([[CHANNEL, channel(CHANNEL, 'patches')], [RUST_CHANNEL, channel(RUST_CHANNEL, 'rust-patch-notes')]]);
  const guild = {
    id: GUILD,
    channels: { cache: channels },
    roles: { cache: new Map([[ROLE, { id: ROLE, name: 'Rust updates', managed: false }], ['999999999999999999', { id: '999999999999999999', name: 'Bot', managed: true }]]) },
    members: { me: { roles: { highest: { position: 9 } } } },
  };
  const client = {
    user: { id: 'cloudy' },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    db: {
      get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    },
  };
  return { store, sent, guild, client, ctx: { client, guild } };
}

function bannerNetwork(t) {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'https://files.facepunch.com/banner.png') {
      return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => png };
    }
    throw new Error(`Unexpected request ${url}`);
  });
}

test('Patchbot is off by default with Rust as the only game', () => {
  assert.deepEqual(normalizePatchbotConfig(undefined), { enabled: false, channelId: null, roleId: null, games: { rust: true } });
  assert.deepEqual(normalizePatchbotConfig({ enabled: true, channelId: 'x', games: { rust: false, csgo: true } }),
    { enabled: true, channelId: null, roleId: null, games: { rust: false } });
});

test('the website setting validates channel, role and game before saving', async () => {
  const w = world();
  assert.deepEqual(MODULES.patchbot.fields.games, { t: 'flags', keys: ['rust'] });
  const current = await MODULES.patchbot.read(w.ctx);
  await assert.rejects(() => MODULES.patchbot.write(w.ctx, { enabled: true }, current), /Choose a channel/);
  await assert.rejects(() => MODULES.patchbot.write(w.ctx, { channelId: '999999999999999998' }, current), /valid text channel/);
  await assert.rejects(() => MODULES.patchbot.write(w.ctx, { roleId: '999999999999999999' }, current), /normal server role/);
  await assert.rejects(() => MODULES.patchbot.write(w.ctx, { enabled: true, channelId: CHANNEL, games: { rust: false } }, current), /at least one game/);
  await MODULES.patchbot.write(w.ctx, { enabled: true, channelId: CHANNEL, roleId: ROLE }, current);
  assert.deepEqual(await MODULES.patchbot.read(w.ctx), { enabled: true, channelId: CHANNEL, roleId: ROLE, games: { rust: true } });
  assert.equal(typeof MODULES.patchbot.actions.postlatest, 'function');
});

test('Patchbot posts only new Rust updates in the chosen channel and tags the chosen role', async t => {
  bannerNetwork(t);
  const w = world();
  await MODULES.patchbot.write(w.ctx, { enabled: true, channelId: CHANNEL, roleId: ROLE }, await MODULES.patchbot.read(w.ctx));
  // First check after switching on: the current update is only remembered.
  assert.equal(await deliverPatchbotUpdates(w.client, 'rust', patch(1)), 0);
  assert.equal(w.sent.length, 0);
  assert.equal(await deliverPatchbotUpdates(w.client, 'rust', patch(1)), 0);
  // A newer update is posted once, with the role tagged.
  assert.equal(await deliverPatchbotUpdates(w.client, 'rust', patch(2)), 1);
  assert.equal(await deliverPatchbotUpdates(w.client, 'rust', patch(2)), 0);
  assert.equal(w.sent.length, 1);
  const { channelId, payload } = w.sent[0];
  assert.equal(channelId, CHANNEL);
  assert.equal(payload.content, `<@&${ROLE}>`);
  assert.deepEqual(payload.allowedMentions, { parse: [], roles: [ROLE] });
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'Rust update 2');
  assert.equal(embed.author.name, 'RUST • OFFICIAL UPDATE');
  assert.match(embed.image.url, /^attachment:\/\//);
  assert.equal(payload.files.length, 1);
});

test('Patchbot never posts in Cloudy\'s own #rust-patch-notes and stays silent when off', async t => {
  bannerNetwork(t);
  const w = world();
  await MODULES.patchbot.write(w.ctx, { enabled: true, channelId: RUST_CHANNEL }, await MODULES.patchbot.read(w.ctx));
  await deliverPatchbotUpdates(w.client, 'rust', patch(1), { skipChannelIds: [RUST_CHANNEL] });
  await deliverPatchbotUpdates(w.client, 'rust', patch(2), { skipChannelIds: [RUST_CHANNEL] });
  assert.equal(w.sent.length, 0);
  const off = world();
  await deliverPatchbotUpdates(off.client, 'rust', patch(1));
  await deliverPatchbotUpdates(off.client, 'rust', patch(2));
  assert.equal(off.sent.length, 0);
});
