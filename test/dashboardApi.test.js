import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import {
  DASHBOARD_PREFIX, canonicalString, checkValue, createDashboardHandler, createDiscordIdentity, createNonceStore, revisionOf, verifySignedRequest,
} from '../src/web/dashboardApi.js';

const SECRET = 's'.repeat(48);
const GUILD = '111111111111111111';
const ADMIN = '222222222222222222';
const MEMBER = '333333333333333333';
const NOW = 1_800_000_000_000;

function sign({ method, path, body = '', actor = ADMIN, nonce = randomBytes(16).toString('base64url'), ts = Math.floor(NOW / 1000), secret = SECRET }) {
  const timestamp = String(ts);
  const signature = createHmac('sha256', secret).update(canonicalString({ method, path, timestamp, nonce, actorId: actor, body })).digest('base64url');
  return {
    'x-cloudy-dashboard-timestamp': timestamp, 'x-cloudy-dashboard-nonce': nonce,
    'x-cloudy-dashboard-actor': actor, 'x-cloudy-dashboard-signature': signature,
  };
}

function fakeClient() {
  const permissions = flags => ({ has: flag => flags.includes(flag) });
  const members = new Map([
    [ADMIN, { id: ADMIN, permissions: permissions([PermissionFlagsBits.ManageGuild]), roles: { cache: new Map() } }],
    [MEMBER, { id: MEMBER, permissions: permissions([]), roles: { cache: new Map() } }],
  ]);
  const guild = {
    id: GUILD, name: 'Cloudy', ownerId: '444444444444444444', memberCount: 10, icon: null,
    members: { cache: members, fetch: async () => null, me: { permissions: permissions([PermissionFlagsBits.ViewChannel]), roles: { highest: { position: 5 } } } },
    channels: { cache: new Map([['555555555555555555', { id: '555555555555555555', name: 'general', type: 0, parentId: null, rawPosition: 1 }]]) },
    roles: { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0 }], ['666666666666666666', { id: '666666666666666666', name: 'Mods', color: 0, position: 2, managed: false }]]) },
  };
  const store = new Map();
  return {
    guild,
    store,
    client: {
      isReady: () => true,
      user: { id: '777777777777777777' },
      guilds: { cache: new Map([[GUILD, guild]]) },
      db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } },
    },
  };
}

function makeHandler(overrides = {}) {
  const state = { values: { enabled: false, channelId: null }, writes: [] };
  const { client, store } = fakeClient();
  const modules = {
    counting: {
      fields: { enabled: { t: 'bool' }, channelId: { t: 'id' } },
      read: async () => ({ ...state.values }),
      write: async (_ctx, changes) => { state.writes.push(changes); Object.assign(state.values, changes); },
      actions: { ping: async () => 'pong' },
    },
  };
  const handle = createDashboardHandler({ client, env: { CLOUDY_DASHBOARD_API_SECRET: SECRET }, nonces: createNonceStore(() => NOW), modules, insights: { demo: async () => ({ stats: [], tables: [] }) }, now: () => NOW, ...overrides });
  return { handle, state, store };
}

async function call(handle, { method = 'GET', path, payload, headers }) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const fullPath = `${DASHBOARD_PREFIX}${path}`;
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handle({ method, originalUrl: fullPath, headers: headers || sign({ method, path: fullPath, body }), body: Buffer.from(body) }, res);
  return res;
}

test('signatures: valid, wrong secret, expired, replayed and malformed requests', () => {
  const nonces = createNonceStore(() => NOW);
  const path = `${DASHBOARD_PREFIX}/meta`;
  const headers = sign({ method: 'GET', path, nonce: 'abcdefghijklmnop' });
  assert.equal(verifySignedRequest({ method: 'GET', path, headers, body: '', secret: SECRET, nonces, nowMs: NOW }).ok, true);
  assert.equal(verifySignedRequest({ method: 'GET', path, headers, body: '', secret: SECRET, nonces, nowMs: NOW }).code, 'replayed');
  const other = sign({ method: 'GET', path, nonce: 'bbbbbbbbbbbbbbbb', secret: 'x'.repeat(48) });
  assert.equal(verifySignedRequest({ method: 'GET', path, headers: other, body: '', secret: SECRET, nonces, nowMs: NOW }).code, 'unauthorized');
  const old = sign({ method: 'GET', path, nonce: 'cccccccccccccccc', ts: Math.floor(NOW / 1000) - 120 });
  assert.equal(verifySignedRequest({ method: 'GET', path, headers: old, body: '', secret: SECRET, nonces, nowMs: NOW }).code, 'expired');
  const tampered = sign({ method: 'PATCH', path, nonce: 'dddddddddddddddd', body: '{"a":1}' });
  assert.equal(verifySignedRequest({ method: 'PATCH', path, headers: tampered, body: '{"a":2}', secret: SECRET, nonces, nowMs: NOW }).code, 'unauthorized');
  assert.equal(verifySignedRequest({ method: 'GET', path, headers: { ...headers, 'x-cloudy-dashboard-actor': 'x' }, body: '', secret: SECRET, nonces, nowMs: NOW }).code, 'unauthorized');
  assert.equal(verifySignedRequest({ method: 'GET', path, headers, body: '', secret: 'short', nonces, nowMs: NOW }).code, 'not_configured');
});

test('the signature matches what the website sends', () => {
  const body = '{"x":1}';
  const canonical = canonicalString({ method: 'patch', path: '/p', timestamp: '1700000000', nonce: 'n', actorId: '1', body });
  assert.equal(canonical, ['cloudy-dashboard-v1', 'PATCH', '/p', '1700000000', 'n', '1', createHash('sha256').update(body).digest('hex')].join('\n'));
});

test('unsigned requests and members without Manage Server are rejected', async () => {
  const { handle } = makeHandler();
  assert.equal((await call(handle, { path: '/meta', headers: {} })).statusCode, 401);
  const asMember = await call(handle, { path: `/guilds/${GUILD}/overview`, headers: sign({ method: 'GET', path: `${DASHBOARD_PREFIX}/guilds/${GUILD}/overview`, actor: MEMBER }) });
  assert.equal(asMember.statusCode, 403);
  assert.equal((await call(handle, { path: `/guilds/888888888888888888/overview` })).statusCode, 404);
});

test('presence and overview return only what Cloudy can see', async () => {
  const { handle } = makeHandler();
  const presence = await call(handle, { method: 'POST', path: '/guilds/presence', payload: { guildIds: [GUILD, '999999999999999999', 'bad'] } });
  assert.deepEqual(presence.body, { present: [GUILD] });
  const overview = await call(handle, { path: `/guilds/${GUILD}/overview` });
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.body.channels[0].type, 'text');
  assert.deepEqual(overview.body.roles.map(role => role.name), ['Mods'], '@everyone is never offered');
  assert.equal((await call(handle, { path: '/meta' })).body.applicationId, '777777777777777777');
});

test('module reads carry a revision; writes need the current revision and valid values', async () => {
  const { handle, state, store } = makeHandler();
  const read = await call(handle, { path: `/guilds/${GUILD}/modules/counting` });
  assert.equal(read.body.revision, revisionOf({ enabled: false, channelId: null }));

  const stale = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: 'old', changes: { enabled: true } } });
  assert.equal(stale.statusCode, 409);
  assert.equal(state.writes.length, 0);

  const unknown = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: read.body.revision, changes: { admin: true } } });
  assert.equal(unknown.statusCode, 422);
  const invalid = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: read.body.revision, changes: { channelId: 'nope' } } });
  assert.equal(invalid.statusCode, 422);
  assert.equal(state.writes.length, 0);

  const ok = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: read.body.revision, changes: { enabled: true, channelId: '555555555555555555' } } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.values, { enabled: true, channelId: '555555555555555555' });
  assert.notEqual(ok.body.revision, read.body.revision);
  const audit = store.get(`guild:${GUILD}:dashboard:audit`);
  assert.equal(audit[0].actor, ADMIN);
  assert.deepEqual(audit[0].keys, ['enabled', 'channelId']);
  assert.equal(JSON.stringify(audit).includes('555555555555555555'), false, 'values are never written to the audit');
});

test('actions, insights and unknown routes', async () => {
  const { handle } = makeHandler();
  assert.deepEqual((await call(handle, { method: 'POST', path: `/guilds/${GUILD}/modules/counting/actions/ping`, payload: {} })).body, { ok: true, message: 'pong' });
  assert.equal((await call(handle, { method: 'POST', path: `/guilds/${GUILD}/modules/counting/actions/nuke`, payload: {} })).statusCode, 404);
  assert.equal((await call(handle, { path: `/guilds/${GUILD}/insights/demo` })).statusCode, 200);
  assert.equal((await call(handle, { path: `/guilds/${GUILD}/insights/nope` })).statusCode, 404);
  assert.equal((await call(handle, { path: `/guilds/${GUILD}/modules/nope` })).statusCode, 404);
});

test('writes are rate limited per member', async () => {
  const { handle } = makeHandler();
  let last;
  for (let index = 0; index < 31; index += 1) {
    last = await call(handle, { method: 'POST', path: `/guilds/${GUILD}/modules/counting/actions/ping`, payload: {} });
  }
  assert.equal(last.statusCode, 429);
});

test('a starting bot answers 503 instead of guessing', async () => {
  const { client } = fakeClient();
  client.isReady = () => false;
  const handle = createDashboardHandler({ client, env: { CLOUDY_DASHBOARD_API_SECRET: SECRET }, nonces: createNonceStore(() => NOW), now: () => NOW });
  assert.equal((await call(handle, { path: '/meta' })).statusCode, 503);
});

test('value rules', () => {
  assert.equal(checkValue({ t: 'text', max: 10, min: 1 }, ''), false);
  assert.equal(checkValue({ t: 'text', max: 10, min: 1 }, 'a\nb'), false);
  assert.equal(checkValue({ t: 'url', max: 100 }, 'http://x.example'), false);
  assert.equal(checkValue({ t: 'url', max: 100 }, 'https://x.example/a.png'), true);
  assert.equal(checkValue({ t: 'ids', max: 2 }, ['123456789012345678', '123456789012345678']), false);
  assert.equal(checkValue({ t: 'levelRoles' }, { 501: '123456789012345678' }), false);
  assert.equal(checkValue({ t: 'flags', keys: ['a'] }, { b: true }), false);
  assert.equal(checkValue({ t: 'num', min: 1, max: 5 }, 2.5), false);
  assert.equal(checkValue({ t: 'list', min: 1, max: 2, itemMax: 5 }, ['  ']), false);
});

test('real modules write through Cloudy services: commands, logging, welcome, leveling', async () => {
  const { MODULES } = await import('../src/web/dashboardApi.js');
  const store = new Map();
  const guildId = '121212121212121212';
  const client = { db: { get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback), set: async (key, value) => { store.set(key, structuredClone(value)); return true; } } };
  const textChannel = { id: '131313131313131313', name: 'logs', type: 0 };
  const role = { id: '141414141414141414', name: 'Level 10', position: 1, managed: false };
  const guild = {
    id: guildId,
    channels: { cache: new Map([[textChannel.id, textChannel]]) },
    roles: { cache: new Map([[role.id, role]]) },
    members: { me: { roles: { highest: { position: 9 } } } },
  };
  const ctx = { client, guild };

  // Commands: disabling and enabling again removes the key, like /commands.
  await MODULES.commands.write(ctx, { disabledCategories: { music: true, search: true } });
  assert.deepEqual((await MODULES.commands.read(ctx)).disabledCategories, { music: true, search: true });
  await MODULES.commands.write(ctx, { disabledCategories: { search: true } });
  assert.deepEqual((await MODULES.commands.read(ctx)).disabledCategories, { search: true });

  // Logging: nested values change without dropping the others.
  await MODULES.logging.write(ctx, { 'logging.enabled': true, 'logging.channels.audit': textChannel.id });
  await MODULES.logging.write(ctx, { 'logging.enabledEvents': { 'message.delete': true } });
  const logging = await MODULES.logging.read(ctx);
  assert.equal(logging['logging.enabled'], true);
  assert.equal(logging['logging.channels.audit'], textChannel.id);
  assert.deepEqual(logging['logging.enabledEvents'], { 'message.delete': true });
  await assert.rejects(() => MODULES.logging.write(ctx, { 'logging.channels.audit': '999999999999999999' }), /valid text channel/);

  // Welcome: the goodbye embed keeps its other fields.
  await MODULES.welcome.write(ctx, { goodbyeEnabled: true, 'leaveEmbed.title': 'Bye', 'leaveEmbed.color': '#FF0000' });
  const welcome = await MODULES.welcome.read(ctx);
  assert.equal(welcome.goodbyeEnabled, true);
  assert.equal(welcome['leaveEmbed.title'], 'Bye');
  assert.equal(welcome['leaveEmbed.color'], '#FF0000');
  assert.ok(welcome['leaveEmbed.footer'].length > 0, 'existing footer kept');

  // Leveling lives inside the guild config.
  const before = await MODULES.leveling.read(ctx);
  await MODULES.leveling.write(ctx, { 'xpRange.min': 5, roleRewards: { 10: role.id } }, before);
  const leveling = await MODULES.leveling.read(ctx);
  assert.equal(leveling['xpRange.min'], 5);
  assert.equal(leveling['xpRange.max'], before['xpRange.max']);
  assert.deepEqual(leveling.roleRewards, { 10: role.id });
  await assert.rejects(() => MODULES.leveling.write(ctx, { 'xpRange.min': 400, 'xpRange.max': 10 }, leveling), /Minimum XP/);
});

test('a refused write leaves no unhandled rejection and the next write still runs', async () => {
  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const { client } = fakeClient();
    let calls = 0;
    const modules = {
      counting: {
        fields: { enabled: { t: 'bool' } },
        read: async () => ({ enabled: false }),
        write: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('nope'), { status: 400 }); },
      },
    };
    const handle = createDashboardHandler({ client, env: { CLOUDY_DASHBOARD_API_SECRET: SECRET }, nonces: createNonceStore(() => NOW), modules, now: () => NOW });
    const revision = revisionOf({ enabled: false });
    const first = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision, changes: { enabled: true } } });
    assert.equal(first.statusCode, 500);
    const second = await call(handle, { method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision, changes: { enabled: true } } });
    assert.equal(second.statusCode, 200);
    await new Promise(resolve => { setTimeout(resolve, 20); });
    assert.equal(rejections.length, 0);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('a Discord login token identifies the dashboard user through Discord itself', async () => {
  let lookups = 0;
  const identify = createDiscordIdentity({
    fetchImpl: async (_url, init) => {
      lookups += 1;
      const ok = init.headers.Authorization === 'Bearer valid-discord-token-1234567890';
      return { ok, json: async () => (ok ? { id: ADMIN } : {}) };
    },
    now: () => NOW,
  });
  assert.equal(await identify('valid-discord-token-1234567890'), ADMIN);
  assert.equal(await identify('valid-discord-token-1234567890'), ADMIN);
  assert.equal(lookups, 1, 'cached per token');
  assert.equal(await identify('wrong-discord-token-1234567890'), null);
  assert.equal(await identify('x'), null, 'malformed tokens never reach Discord');

  const { client } = fakeClient();
  const handle = createDashboardHandler({ client, env: {}, nonces: createNonceStore(() => NOW), now: () => NOW, identify });
  const res = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  const path = `${DASHBOARD_PREFIX}/guilds/${GUILD}/overview`;
  await handle({ method: 'GET', originalUrl: path, headers: { authorization: 'Bearer valid-discord-token-1234567890' }, body: Buffer.from('') }, res);
  assert.equal(res.statusCode, 200);
  const denied = { ...res, statusCode: 0 };
  await handle({ method: 'GET', originalUrl: path, headers: { authorization: 'Bearer wrong-discord-token-1234567890' }, body: Buffer.from('') }, denied);
  assert.equal(denied.statusCode, 401);
  const none = { ...res, statusCode: 0 };
  await handle({ method: 'GET', originalUrl: path, headers: {}, body: Buffer.from('') }, none);
  assert.equal(none.statusCode, 401);
});

test('plan: free trial starts with the first save, then saving needs Premium', async () => {
  let clock = NOW;
  const { handle, state, store } = makeHandler({ now: () => clock, nonces: createNonceStore(() => clock) });
  const headersAt = (method, path, body) => sign({ method, path: `${DASHBOARD_PREFIX}${path}`, body, ts: Math.floor(clock / 1000) });
  const at = async ({ method = 'GET', path, payload }) => call(handle, { method, path, payload, headers: headersAt(method, path, payload === undefined ? '' : JSON.stringify(payload)) });

  const fresh = await at({ path: `/guilds/${GUILD}/overview` });
  assert.equal(fresh.body.plan.status, 'new');
  assert.equal(fresh.body.plan.canSave, true);
  assert.equal(fresh.body.plan.priceEur, 13);

  const read = await at({ path: `/guilds/${GUILD}/modules/counting` });
  const saved = await at({ method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: read.body.revision, changes: { enabled: true } } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.plan.status, 'trial');
  assert.equal(saved.body.plan.until, new Date(NOW + 7 * 86_400_000).toISOString());
  assert.equal(store.get(`guild:${GUILD}:dashboard:plan`).trialStartedBy, ADMIN);

  clock = NOW + 8 * 86_400_000;
  const ended = await at({ path: `/guilds/${GUILD}/overview` });
  assert.equal(ended.body.plan.status, 'expired');
  assert.equal(ended.body.plan.canSave, false);
  assert.equal((await at({ path: `/guilds/${GUILD}/modules/counting` })).statusCode, 200, 'settings stay visible');
  const again = await at({ path: `/guilds/${GUILD}/modules/counting` });
  const refused = await at({ method: 'PATCH', path: `/guilds/${GUILD}/modules/counting`, payload: { revision: again.body.revision, changes: { enabled: false } } });
  assert.equal(refused.statusCode, 402);
  assert.equal(refused.body.code, 'plan_required');
  assert.equal((await at({ method: 'POST', path: `/guilds/${GUILD}/modules/counting/actions/ping`, payload: {} })).statusCode, 402);
  assert.equal(state.writes.length, 1, 'nothing changed after the trial');
});

test('plan: only Cloudy\'s owner can turn Premium on, and owners always save', async () => {
  const { handle, store } = makeHandler({ env: { CLOUDY_DASHBOARD_API_SECRET: SECRET, OWNER_IDS: ` ${MEMBER} ` } });
  const grantPath = '/plans/grant';
  const denied = await call(handle, { method: 'POST', path: grantPath, payload: { guildId: GUILD, months: 1 } });
  assert.equal(denied.statusCode, 403, 'a server admin cannot grant Premium');

  const owner = (method, path, payload) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return call(handle, { method, path, payload, headers: sign({ method, path: `${DASHBOARD_PREFIX}${path}`, body, actor: MEMBER }) });
  };
  assert.equal((await owner('POST', grantPath, { guildId: 'nope', months: 1 })).statusCode, 422);
  assert.equal((await owner('POST', grantPath, { guildId: GUILD, months: 99 })).statusCode, 422);
  assert.equal((await owner('POST', grantPath, { guildId: '999999999999999999', months: 1 })).statusCode, 404);
  const granted = await owner('POST', grantPath, { guildId: GUILD, months: 2 });
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.body.plan.status, 'premium');
  assert.equal(granted.body.plan.until, new Date(NOW + 60 * 86_400_000).toISOString());
  const extended = await owner('POST', grantPath, { guildId: GUILD, months: 1 });
  assert.equal(extended.body.plan.until, new Date(NOW + 90 * 86_400_000).toISOString(), 'months are added to what is left');
  assert.equal((await call(handle, { path: `/guilds/${GUILD}/overview` })).body.plan.status, 'premium');
  const off = await owner('POST', grantPath, { guildId: GUILD, months: 0 });
  assert.equal(off.body.plan.status, 'expired');
  assert.equal(store.get(`guild:${GUILD}:dashboard:audit`)[0].keys[0], 'premium:off');
});

test('plan: the Discord application owner counts as Cloudy\'s owner', async () => {
  const { client } = fakeClient();
  client.application = { owner: { members: new Map([[ADMIN, {}]]) } };
  client.db.set(`guild:${GUILD}:dashboard:plan`, { trialEndsAt: new Date(NOW - 1).toISOString() });
  const handle = createDashboardHandler({ client, env: { CLOUDY_DASHBOARD_API_SECRET: SECRET }, nonces: createNonceStore(() => NOW), now: () => NOW });
  const overview = await call(handle, { path: `/guilds/${GUILD}/overview` });
  assert.equal(overview.body.plan.status, 'owner');
  assert.equal(overview.body.plan.canSave, true);
});
