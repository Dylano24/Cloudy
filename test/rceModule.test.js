import test from 'node:test';
import assert from 'node:assert/strict';

process.env.RCE_ENCRYPTION_KEY = 'test-key-for-rce-module-0123456789';

const parser = await import('../src/services/rce/rceParser.js');
const { rceCommand, safePlayerName, renderCommandTemplate, RceCommandError, safeText } = await import('../src/services/rce/rceCommands.js');
const store = await import('../src/services/rce/rceStore.js');
const data = await import('../src/services/rce/rceData.js');
const { isPrivateAddress, assertPublicHost } = await import('../src/services/rce/rceNetwork.js');
const { RceSession } = await import('../src/services/rce/rceSession.js');
const { createRceRuntime } = await import('../src/services/rce/rceRuntime.js');
const { parseDeliveryLines, resolveServers } = await import('../src/services/rce/rceDelivery.js');

const GUILD = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tick = () => new Promise(resolve => { setImmediate(resolve); });
async function settle(times = 8) { for (let i = 0; i < times; i++) await tick(); }

function memoryDb() {
  const map = new Map();
  return {
    map,
    get: async (key, fallback = null) => (map.has(key) ? structuredClone(map.get(key)) : fallback),
    set: async (key, value) => { map.set(key, structuredClone(value)); return true; },
    delete: async key => map.delete(key),
  };
}

// ------------------------------------------------------------------ parser

test('kill lines classify players, scientists, animals, entities and natural causes', () => {
  const pvp = parser.parseConsoleLine('Dylano was killed by Dyn Cloudy');
  assert.equal(pvp.type, 'kill');
  assert.deepEqual([pvp.victim.type, pvp.victim.name, pvp.killer.type, pvp.killer.name], ['player', 'Dylano', 'player', 'Dyn Cloudy']);
  assert.equal(parser.parseConsoleLine('1337424001 was killed by Dylano').victim.type, 'npc');
  assert.equal(parser.parseConsoleLine('Dylano was killed by 1337424001').killer.name, 'Scientist');
  assert.deepEqual(parser.classifyKillParty('bear'), { id: 'bear', name: 'Bear', type: 'npc' });
  assert.equal(parser.classifyKillParty('autoturret_deployed (entity)').name, 'Auto Turret');
  assert.equal(parser.classifyKillParty('Fall!').type, 'natural');
  assert.equal(parser.classifyKillParty('patrolhelicopter (entity)').type, 'npc');
  assert.equal(parser.classifyKillParty('something.new (entity)').type, 'entity');
  assert.equal(parser.parseConsoleLine('Dylano was suicide by Suicide').type, 'suicide');
});

test('quick chat, notes, respawns, teams, roles, bans, kits, items and world events are parsed', () => {
  const chat = parser.parseConsoleLine('[CHAT LOCAL] Dyn Cloudy : d11_quick_chat_responses_slot_0');
  assert.deepEqual([chat.type, chat.channel, chat.player, chat.code, chat.label], ['chat', 'local', 'Dyn Cloudy', 'd11_quick_chat_responses_slot_0', 'Yes']);
  assert.equal(parser.parseConsoleLine('[CHAT TEAM] Dyn : d11_quick_chat_i_need_phrase_format d11_Wood').label, 'I need wood');
  assert.equal(parser.quickChatCode('Can I build around here?'), 'd11_quick_chat_questions_slot_1');
  const note = parser.parseConsoleLine('[NOTE PANEL] Player [ Dylano ] changed name from [  ] to [ CLOUDY-123456\\nmore ]');
  assert.deepEqual([note.type, note.player, note.text], ['note', 'Dylano', 'CLOUDY-123456']);
  assert.equal(parser.parseConsoleLine('[NOTE PANEL] Player [ Dylano ] changed name from [ a ] to [ a ]'), null);
  const respawn = parser.parseConsoleLine('Dylano [SCARLETT] has entered the game');
  assert.deepEqual([respawn.type, respawn.player, respawn.platform], ['respawn', 'Dylano', 'xbox']);
  assert.equal(parser.parseConsoleLine('PSPlayer [PS5] has entered the game').platform, 'playstation');
  assert.deepEqual(parser.parseConsoleLine('[Dylano] created a new team, ID: 42'), { type: 'teamCreate', player: 'Dylano', team: '42', line: '[Dylano] created a new team, ID: 42' });
  assert.equal(parser.parseConsoleLine('[Dyn] has joined [Dylano]s team, ID: [42]').type, 'teamJoin');
  assert.equal(parser.parseConsoleLine('[Dyn] has left [Dylano]s team, ID: [42]').type, 'teamLeave');
  assert.equal(parser.parseConsoleLine('[Dylano] promoted [Dyn] as their new leader of the team, ID: [42]').leader, 'Dyn');
  assert.deepEqual(parser.parseConsoleLine('[SERVER] Added [Dyn] to Group [VIP]').role, 'VIP');
  assert.equal(parser.parseConsoleLine('[SERVER] Added [Dyn] to [Banned]').type, 'ban');
  assert.equal(parser.parseConsoleLine('[Admin] Removed [Dyn] from [Banned]').type, 'unban');
  assert.deepEqual(parser.parseConsoleLine('SERVER giving Dylano kit starter').kit, 'starter');
  const item = parser.parseConsoleLine('[ServerVar] giving Dylano 1000 x Wood');
  assert.deepEqual([item.type, item.player, item.amount, item.item], ['item', 'Dylano', 1000, 'Wood']);
  assert.equal(parser.parseConsoleLine('[EVENT] event_cargoship started').event, 'Cargo Ship');
  assert.equal(parser.parseConsoleLine('Successfully created zone [ZORP_1]').zone, 'ZORP_1');
  assert.equal(parser.parseConsoleLine('random server noise'), null);
});

test('player lists, server info, team info, positions and zone lists are read', () => {
  assert.deepEqual(parser.parsePlayerList('[{"DisplayName":"Dylano","Ping":30,"ConnectedSeconds":60,"Health":99.6}]'),
    [{ name: 'Dylano', ping: 30, connectedSeconds: 60, health: 100 }]);
  assert.deepEqual(parser.parsePlayerList('<slot:"name">\n"Dylano"\n"Dyn Cloudy"\n2 users').map(entry => entry.name), ['Dylano', 'Dyn Cloudy']);
  assert.equal(parser.parsePlayerList('Unknown command'), null);
  const info = parser.parseServerInfo('{"Hostname":"Cloudy Rust","MaxPlayers":100,"Players":87,"Queued":3,"Map":"Procedural Map","Framerate":60}');
  assert.deepEqual([info.hostname, info.players, info.maxPlayers, info.queued], ['Cloudy Rust', 87, 100, 3]);
  assert.equal(parser.parseServerInfo('not json'), null);
  const teams = parser.parseTeamInfo('Team 42 member list:\nDylano [1001] (LEADER)\nDyn [1002]\nTeam 7 member list:\nSolo [1003]');
  assert.deepEqual(teams, [{ id: '42', leader: 'Dylano', members: ['Dylano', 'Dyn'] }, { id: '7', leader: 'Solo', members: ['Solo'] }]);
  assert.deepEqual(parser.parseTeamInfo('No teams found'), []);
  assert.deepEqual(parser.parsePosition('Dylano position: (1200.5, 35.2, -980.1)'), { x: 1200.5, y: 35.2, z: -980.1 });
  assert.equal(parser.parsePosition('nothing'), null);
  assert.deepEqual(parser.parseZoneList('Name [ZORP_1] Enabled [True]\nName [Outpost] Enabled [False]').map(zone => zone.name), ['ZORP_1', 'Outpost']);
});

// ------------------------------------------------------------------ commands

test('console commands use the community server syntax and refuse injected arguments', () => {
  assert.equal(rceCommand.say('Hello "world"; quit'), `global.say "Hello 'world' quit"`);
  assert.equal(rceCommand.kit('starter', 'Dyn Cloudy'), 'kit givetoplayer "starter" "Dyn Cloudy"');
  assert.equal(rceCommand.giveItem('Dylano', 'rifle.ak', 2), 'inventory.giveto "Dylano" "rifle.ak" 2');
  assert.equal(rceCommand.teleport('Dylano', { x: 1, y: 2.5, z: -3 }), 'global.teleportpos (1,2.5,-3) "Dylano"');
  assert.equal(rceCommand.ban('Dylano', 'Cheating', 600), 'global.banid "Dylano" "Cheating" "600"');
  assert.equal(rceCommand.ban('Dylano', 'Cheating'), 'global.banid "Dylano" "Cheating"');
  assert.equal(rceCommand.addVip('Dylano'), 'VIPID "Dylano"');
  assert.equal(rceCommand.printPosition('Dylano'), 'server.printpos "Dylano"');
  assert.equal(rceCommand.createZone('ZORP_ab', { x: 10, y: 20, z: 30 }, 30), 'zones.createcustomzone "ZORP_ab" (10,20,30) 0 Sphere 30 1 1 0 1 1');
  assert.equal(rceCommand.editZone('ZORP_ab', 'color', [255, 0, 0]), 'zones.editcustomzone "ZORP_ab" color (255,0,0)');
  assert.equal(rceCommand.editZone('ZORP_ab', 'allowbuildingdamage', false), 'zones.editcustomzone "ZORP_ab" allowbuildingdamage 0');
  for (const bad of ['a" ; ban all', 'name\nquit', 'semi;colon', '', '   ', 'x'.repeat(40), 'back\\slash']) {
    assert.throws(() => safePlayerName(bad), RceCommandError, bad);
  }
  assert.throws(() => rceCommand.giveItem('Dylano', 'rifle"ak', 1), RceCommandError);
  assert.throws(() => rceCommand.kit('star ter', 'Dylano'), RceCommandError);
  assert.throws(() => rceCommand.editZone('Z', 'quit', 1), RceCommandError);
  assert.equal(renderCommandTemplate('inventory.giveto "{player}" "wood" 1000', 'Dyn Cloudy'), 'inventory.giveto "Dyn Cloudy" "wood" 1000');
  assert.throws(() => renderCommandTemplate('say hi', 'Dyn'), RceCommandError);
  assert.throws(() => safeText(''), RceCommandError);
});

test('only public game server addresses are allowed', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('51.38.10.20'), false);
  await assert.rejects(assertPublicHost('lavalink.railway.internal'));
  await assert.rejects(assertPublicHost('localhost'));
  await assert.rejects(assertPublicHost('rust.example.com', async () => [{ address: '10.0.0.5' }]));
  await assertPublicHost('rust.example.com', async () => [{ address: '51.38.10.20' }]);
  await assertPublicHost('51.38.10.20');
});

// ------------------------------------------------------------------ store

test('RCON passwords are stored encrypted and settings are normalized', () => {
  const sealed = store.sealSecret('my-rcon-password');
  assert.equal(JSON.stringify(sealed).includes('my-rcon-password'), false);
  assert.equal(store.openSecret(sealed), 'my-rcon-password');
  assert.equal(store.openSecret(sealed, { RCE_ENCRYPTION_KEY: 'another-key-that-is-long-enough' }), null);
  const config = store.normalizeRceConfig({
    servers: [{ id: 'main', name: 'Cloudy Rust', host: '51.38.10.20', port: 28016, password: sealed }, { id: 'MAIN', host: 'x', port: 0 }],
    channels: { killfeed: '444444444444444444', bogus: '1' },
    emotes: [{ trigger: 'd11_quick_chat_responses_slot_5', action: 'kit', value: 'starter' }, { trigger: 'not-a-code', action: 'kit', value: 'x' }],
    settings: { rewards: { kill: 50 } },
  });
  assert.equal(config.servers.length, 1);
  assert.deepEqual(config.channels, { killfeed: '444444444444444444' });
  assert.equal(config.emotes.length, 1);
  assert.equal(config.emotes[0].cooldownMinutes, 60);
  assert.equal(config.settings.rewards.kill, 50);
  assert.equal(store.slugify('Cloudy Rust #1', ['cloudy-rust-1']), 'cloudy-rust-1-2');
});

test('the Rust module needs Premium, except on Cloudy\'s home servers', async () => {
  const db = memoryDb();
  const client = { db };
  const now = Date.parse('2026-11-16T12:00:00Z');
  assert.equal(await store.rcePlanAllows(client, GUILD, now, {}), false);
  assert.equal(await store.rcePlanAllows(client, GUILD, now, { GUILD_ID: GUILD }), true);
  assert.equal(await store.rcePlanAllows(client, '1532882647838228723', now, {}), true);
  await db.set(`guild:${GUILD}:dashboard:plan`, { premiumUntil: '2026-12-01T00:00:00Z' });
  assert.equal(await store.rcePlanAllows(client, GUILD, now, {}), true);
  await db.set(`guild:${GUILD}:dashboard:plan`, { premiumUntil: '2026-11-01T00:00:00Z' });
  assert.equal(await store.rcePlanAllows(client, GUILD, now, {}), false);
});

test('a gamertag can be linked to one member only, unless staff force it', async () => {
  const client = { db: memoryDb() };
  await data.setLink(client, GUILD, MEMBER, 'Dylano', { method: 'emote' });
  await assert.rejects(data.setLink(client, GUILD, OTHER, 'dylano'), /already linked/);
  await data.setLink(client, GUILD, OTHER, 'DYLANO', { force: true });
  const links = await data.getLinks(client, GUILD);
  assert.equal(data.discordForPlayer(links, 'dylano'), OTHER);
  assert.equal(data.linkForDiscord(links, MEMBER), null);
});

// ------------------------------------------------------------------ fake game server

function fakeRcon(server) {
  return function createClient() {
    const listeners = new Set();
    const closers = new Set();
    const client = {
      async connect() { server.connections += 1; if (server.refuse) throw Object.assign(new Error('refused'), { code: 'connect_failed' }); },
      async send(command) {
        server.sent.push(command);
        if (server.fail?.(command)) throw Object.assign(new Error('timeout'), { name: 'RconError', code: 'timeout' });
        return server.reply(command);
      },
      onMessage(listener) { listeners.add(listener); },
      onClose(listener) { closers.add(listener); },
      close() {},
    };
    server.emit = line => { for (const listener of listeners) listener({ message: line, identifier: 0 }); };
    server.drop = () => { for (const closer of closers) closer({ code: 1006 }); };
    return client;
  };
}

function gameServer({ players = [], teams = '' } = {}) {
  const server = { sent: [], connections: 0, players: [...players], position: '(500, 20, 500)', zoneList: null };
  server.reply = command => {
    if (command === 'playerlist') return JSON.stringify(server.players.map(name => ({ DisplayName: name, Ping: 20, ConnectedSeconds: 60, Health: 100 })));
    if (command === 'serverinfo') return JSON.stringify({ Hostname: 'Cloudy Rust', Players: server.players.length, MaxPlayers: 100, Queued: 0, Map: 'Procedural Map' });
    if (command === 'relationshipmanager.teaminfoall') return teams || 'No teams found';
    if (command.startsWith('server.printpos')) return server.position;
    if (command === 'zones.listcustomzones') return server.zoneList ?? '';
    return 'OK';
  };
  return server;
}

function fakeDiscord(db) {
  const posts = [];
  const roles = [];
  const channel = id => ({ id, isTextBased: () => true, send: async payload => { posts.push({ channel: id, ...payload }); return { id: `m${posts.length}` }; }, messages: { fetch: async () => null } });
  const channels = new Map(['500000000000000001', '500000000000000002', '500000000000000003', '500000000000000004', '500000000000000005', '500000000000000006'].map(id => [id, channel(id)]));
  const guild = {
    id: GUILD, channels: { cache: channels },
    members: { fetch: async id => ({ id, roles: { add: async role => roles.push([id, role]), remove: async () => undefined } }) },
  };
  return { posts, roles, client: { db, guilds: { cache: new Map([[GUILD, guild]]) }, user: { id: '999999999999999999' } } };
}

function fakeEconomy() {
  const wallets = new Map();
  return {
    wallets,
    async addMoney(_client, _guild, user, amount) { wallets.set(user, (wallets.get(user) || 0) + amount); },
    async removeMoney(_client, _guild, user, amount) {
      if ((wallets.get(user) || 0) < amount) throw Object.assign(new Error('Insufficient funds'), { userMessage: 'Not enough money.' });
      wallets.set(user, wallets.get(user) - amount);
    },
  };
}

async function setup({ players = ['Dylano', 'Dyn'], teams = '', configure = null } = {}) {
  const db = memoryDb();
  const discord = fakeDiscord(db);
  const game = gameServer({ players, teams });
  const economy = fakeEconomy();
  let clock = Date.parse('2026-11-16T12:00:00Z');
  await db.set(`guild:${GUILD}:dashboard:plan`, { premiumUntil: '2099-01-01T00:00:00Z' });
  const runtime = createRceRuntime(discord.client, {
    now: () => clock, log: quiet, economy,
    sessionFactory: ({ guildId, server, password, handlers }) => new RceSession({
      guildId, server, password, handlers, now: () => clock, log: quiet, hostCheck: null,
      createClient: fakeRcon(game), poll: { playersMs: 3_600_000, infoMs: 3_600_000, teamsMs: 3_600_000, commandTimeoutMs: 1_000 },
    }),
  });
  await store.updateRceConfig(discord.client, GUILD, config => {
    config.servers = [{ id: 'main', name: 'Cloudy Rust', host: '51.38.10.20', port: 28016, password: store.sealSecret('pw'), enabled: true }];
    config.channels = { killfeed: '500000000000000001', joins: '500000000000000002', chat: '500000000000000003', admin: '500000000000000004', zorp: '500000000000000005', shop: '500000000000000006' };
    configure?.(config);
  });
  await runtime.start();
  await settle(20);
  const session = runtime.session(GUILD, 'main');
  return {
    db, discord, game, economy, runtime, session,
    advance: ms => { clock += ms; }, now: () => clock,
    line: async text => { game.emit(text); await settle(30); },
    async refresh() { await session.refreshPlayers(); await settle(30); },
    async close() { await runtime.stop(); store.clearRceConfigCache(); },
  };
}

test('a game server connects, learns who is online silently, then posts joins and leaves', async () => {
  const t = await setup();
  try {
    assert.equal(t.session.state, 'online');
    assert.equal(t.session.players.size, 2);
    await t.runtime.flushFeeds();
    assert.equal(t.discord.posts.filter(post => post.channel === '500000000000000002').length, 0, 'no join spam on connect');
    t.game.players.push('Newcomer');
    t.advance(60_000);
    await t.refresh();
    t.game.players = t.game.players.filter(name => name !== 'Dyn');
    t.advance(30 * 60_000);
    await t.refresh();
    await t.runtime.flushFeeds();
    const titles = t.discord.posts.filter(post => post.channel === '500000000000000002').flatMap(post => post.embeds.map(embed => embed.title));
    assert.deepEqual(titles.map(title => title.replace(/<[^>]+>\s*/g, '')), ['Login', 'Logout']);
    const stats = await t.runtime.stats.load(GUILD, 'main');
    assert.ok(stats.players.dyn.playtimeMs >= 30 * 60_000);
  } finally { await t.close(); }
});

test('a dropped connection reconnects and the session keeps working', async () => {
  const t = await setup();
  try {
    assert.equal(t.game.connections, 1);
    t.game.drop();
    assert.equal(t.session.state, 'offline');
    t.session.reconnect();
    await settle(20);
    assert.equal(t.session.state, 'online');
    assert.equal(t.game.connections, 2);
  } finally { await t.close(); }
});

test('kills update stats, the kill feed, rewards and bounties; teammates cannot claim', async () => {
  const t = await setup({ configure: config => { config.settings.rewards.kill = 25; config.settings.ingameKillfeed = true; } });
  try {
    await data.setLink(t.discord.client, GUILD, MEMBER, 'Dylano');
    t.economy.wallets.set(OTHER, 1000);
    await t.runtime.placeBounty(GUILD, OTHER, 'Dyn', 500);
    await assert.rejects(t.runtime.placeBounty(GUILD, OTHER, 'Dyn', 5), /minimum/);
    await t.line('Dyn was killed by Dylano');
    await t.line('Bob was killed by Dylano');
    await t.line('Carl was killed by Dylano');
    await t.runtime.flushFeeds();
    const stats = await t.runtime.stats.load(GUILD, 'main');
    assert.equal(stats.players.dylano.kills, 3);
    assert.equal(stats.players.dylano.bestStreak, 3);
    assert.equal(stats.players.dyn.deaths, 1);
    assert.equal(t.economy.wallets.get(MEMBER), 3 * 25 + 500, 'kill rewards plus the bounty');
    assert.equal(t.economy.wallets.get(OTHER), 500);
    assert.deepEqual(await data.getBounties(t.discord.client, GUILD), {});
    const feed = t.discord.posts.filter(post => post.channel === '500000000000000001').flatMap(post => post.embeds);
    assert.equal(feed.length, 3);
    assert.match(feed[0].description, /Bounty claimed/);
    assert.match(feed[2].description, /Killstreak:\*\* 3/);
    assert.ok(t.game.sent.some(command => command === 'global.say "Dylano killed Dyn"'));
    // An NPC death is not shown in "player kills" mode and earns no kill reward.
    await t.line('Dylano was killed by bear');
    await t.runtime.flushFeeds();
    assert.equal(t.discord.posts.filter(post => post.channel === '500000000000000001').flatMap(post => post.embeds).length, 3);
  } finally { await t.close(); }
});

test('linking works with the emotes in order or with the code on a note, from that gamertag only', async () => {
  const t = await setup({ configure: config => { config.settings.linkedRoleId = '600000000000000000'; } });
  try {
    let done = null;
    const challenge = await t.runtime.startLink(GUILD, MEMBER, 'Dylano', result => { done = result; });
    const entry = t.runtime.pendingLinkFor(GUILD, MEMBER);
    const codeFor = label => Object.entries(parser.QUICK_CHAT).find(([, text]) => text === label)[0];
    // Someone else doing the emotes never links Dylano.
    for (const label of challenge.emotes) await t.line(`[CHAT LOCAL] Dyn : ${codeFor(label)}`);
    assert.equal(done, null);
    for (const code of entry.emotes) await t.line(`[CHAT LOCAL] Dylano : ${code}`);
    assert.equal(done?.method, 'emote');
    const links = await data.getLinks(t.discord.client, GUILD);
    assert.equal(data.linkForDiscord(links, MEMBER).gamertag, 'Dylano');
    assert.deepEqual(t.discord.roles, [[MEMBER, '600000000000000000']]);

    const second = await t.runtime.startLink(GUILD, OTHER, 'Dyn');
    await t.line(`[NOTE PANEL] Player [ Dyn ] changed name from [  ] to [ ${second.code} ]`);
    assert.equal(data.linkForDiscord(await data.getLinks(t.discord.client, GUILD), OTHER).gamertag, 'Dyn');
    await assert.rejects(t.runtime.startLink(GUILD, '444444444444444444', 'Dyn'), /already linked/);
  } finally { await t.close(); }
});

test('emote kits respect links, price, cooldowns and once-per-wipe, and refund when the server fails', async () => {
  const t = await setup({
    configure: config => {
      config.emotes = [
        { trigger: 'd11_quick_chat_responses_slot_5', action: 'kit', value: 'starter', cooldownMinutes: 30, price: 100, linkedOnly: true },
        { trigger: 'd11_quick_chat_orders_slot_0', action: 'kit', value: 'wipekit', cooldownMinutes: 0, oncePerWipe: true, linkedOnly: true },
      ];
    },
  });
  try {
    const hello = 'd11_quick_chat_responses_slot_5';
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 0, 'not linked yet');
    await data.setLink(t.discord.client, GUILD, MEMBER, 'Dylano');
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 0, 'not enough money');
    t.economy.wallets.set(MEMBER, 250);
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    assert.deepEqual(t.game.sent.filter(command => command.startsWith('kit givetoplayer')), ['kit givetoplayer "starter" "Dylano"']);
    assert.equal(t.economy.wallets.get(MEMBER), 150);
    t.advance(31 * 60_000);
    t.game.fail = command => command.startsWith('kit givetoplayer "starter"');
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    assert.equal(t.economy.wallets.get(MEMBER), 150, 'refunded after the failed send');
    t.game.fail = null;
    await t.line(`[CHAT LOCAL] Dylano : ${hello}`);
    assert.equal(t.economy.wallets.get(MEMBER), 50, 'the cooldown was released by the failure');

    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_orders_slot_0');
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_orders_slot_0');
    assert.equal(t.game.sent.filter(command => command.includes('"wipekit"')).length, 1);
    await t.runtime.resetWipe(GUILD, 'main');
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_orders_slot_0');
    assert.equal(t.game.sent.filter(command => command.includes('"wipekit"')).length, 2);
  } finally { await t.close(); }
});

test('the Discord shop charges, delivers in game and refunds when delivery is refused', async () => {
  const t = await setup({
    configure: config => {
      config.shop = [
        { id: 'ak', name: 'AK', type: 'item', value: 'rifle.ak', amount: 1, price: 300, cooldownMinutes: 0 },
        { id: 'vip', name: 'VIP 30 days', type: 'vip', price: 1000, vipDays: 30 },
      ];
    },
  });
  try {
    await assert.rejects(t.runtime.buy(GUILD, MEMBER, 'ak'), /Link your gamertag/);
    await data.setLink(t.discord.client, GUILD, MEMBER, 'Dylano');
    await assert.rejects(t.runtime.buy(GUILD, MEMBER, 'ak'), /enough|Not enough/);
    t.economy.wallets.set(MEMBER, 2000);
    const result = await t.runtime.buy(GUILD, MEMBER, 'ak');
    assert.equal(result.unsure, false);
    assert.ok(t.game.sent.includes('inventory.giveto "Dylano" "rifle.ak" 1'));
    assert.equal(t.economy.wallets.get(MEMBER), 1700);
    await t.runtime.buy(GUILD, MEMBER, 'vip');
    assert.ok(t.game.sent.includes('VIPID "Dylano"'));
    const lists = await data.getLists(t.discord.client, GUILD);
    assert.ok(lists.vip[MEMBER].until > t.now());
    t.game.players = ['Dyn'];
    await t.refresh();
    await assert.rejects(t.runtime.buy(GUILD, MEMBER, 'ak'), /Join Cloudy Rust/);
    assert.equal(t.economy.wallets.get(MEMBER), 700);
  } finally { await t.close(); }
});

test('ZORP: the team leader creates a zone, it follows the team online state and expires', async () => {
  const t = await setup({
    teams: 'Team 42 member list:\nDylano [1001] (LEADER)\nDyn [1002]',
    configure: config => { config.zorp = { enabled: true, radius: 30, yellowMinutes: 10, expiryHours: 24, requireList: false }; },
  });
  try {
    await t.session.refreshTeams();
    // A member who is not the leader cannot create one.
    await t.line('[CHAT LOCAL] Dyn : d11_quick_chat_questions_slot_1');
    await t.line('[CHAT LOCAL] Dyn : d11_quick_chat_responses_slot_0');
    assert.equal(t.game.sent.some(command => command.startsWith('zones.createcustomzone')), false);
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_questions_slot_1');
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_responses_slot_0');
    const create = t.game.sent.find(command => command.startsWith('zones.createcustomzone'));
    assert.match(create, /^zones\.createcustomzone "ZORP_[0-9a-f]{6}" \(500,20,500\) 0 Sphere 30 1 1 0 1 1$/);
    const name = /"(ZORP_[0-9a-f]{6})"/.exec(create)[1];
    const zones = async () => (await data.getZones(t.discord.client, GUILD, 'main')).zones;
    assert.equal((await zones())[name].state, 'white');

    t.advance(2 * 60_000);
    await t.runtime.zorp.tickServer(t.session);
    assert.equal((await zones())[name].state, 'green');
    assert.ok(t.game.sent.includes(`zones.editcustomzone "${name}" color (0,255,0)`));

    t.game.players = ['Someone'];
    await t.refresh();
    await t.runtime.zorp.tickServer(t.session);
    assert.equal((await zones())[name].state, 'yellow');
    t.advance(11 * 60_000);
    await t.runtime.zorp.tickServer(t.session);
    assert.equal((await zones())[name].state, 'red');
    assert.ok(t.game.sent.includes(`zones.editcustomzone "${name}" allowbuildingdamage 0`));

    // A second zone that overlaps is refused.
    const { game } = t;
    game.players = ['Someone', 'Solo'];
    game.position = '(510, 20, 505)';
    await t.refresh();
    await t.line('[Solo] created a new team, ID: 7');
    await t.line('[CHAT LOCAL] Solo : d11_quick_chat_questions_slot_1');
    await t.line('[CHAT LOCAL] Solo : d11_quick_chat_responses_slot_0');
    assert.equal(t.game.sent.filter(command => command.startsWith('zones.createcustomzone')).length, 1);

    t.advance(25 * 3_600_000);
    await t.runtime.zorp.tickServer(t.session);
    assert.equal((await zones())[name], undefined, 'expired after 24 hours offline');
    assert.ok(t.game.sent.includes(`zones.deletecustomzone "${name}"`));
  } finally { await t.close(); }
});

test('ZORP: Goodbye removes the zone and a leader leaving the team removes it too', async () => {
  const t = await setup({
    teams: 'Team 42 member list:\nDylano [1001] (LEADER)\nDyn [1002]',
    configure: config => { config.zorp.enabled = true; },
  });
  try {
    await t.session.refreshTeams();
    const createZone = async () => {
      await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_questions_slot_1');
      await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_responses_slot_0');
      return Object.keys((await data.getZones(t.discord.client, GUILD, 'main')).zones);
    };
    assert.equal((await createZone()).length, 1);
    t.advance(2 * 60_000);
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_questions_slot_1');
    await t.line('[CHAT LOCAL] Dylano : d11_quick_chat_responses_slot_6');
    assert.equal(Object.keys((await data.getZones(t.discord.client, GUILD, 'main')).zones).length, 0);
    t.advance(2 * 60_000);
    assert.equal((await createZone()).length, 1);
    await t.line('[Dylano] has left [Dylano]s team, ID: [42]');
    assert.equal(Object.keys((await data.getZones(t.discord.client, GUILD, 'main')).zones).length, 0);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ store deliveries

test('KAOS delivery lines are parsed, including server lists, arrays and ALL', () => {
  const lines = parseDeliveryLines([
    `[KAOS][ADD][<@${MEMBER}>][1]=[ITEM][rifle.ak][2]`,
    `[KAOS][ADD][<@!${MEMBER}>][1,2]=[KIT][elitekit][1]`,
    `[CLOUDY][DEL][<@${MEMBER}>][ALL]=[KITLIST][elitekit, elitekit2]`,
    `[KAOS][ADD][<@${MEMBER}>][1]=[ZORPLIST]`,
    `[KAOS][ADD][<@${MEMBER}>][1]=[NOPE][x]`,
  ].join('\n'));
  assert.deepEqual(lines.map(line => [line.action, line.type, line.servers, line.args]), [
    ['ADD', 'ITEM', '1', ['rifle.ak', '2']],
    ['ADD', 'KIT', '1,2', ['elitekit', '1']],
    ['DEL', 'KITLIST', 'ALL', ['elitekit, elitekit2']],
    ['ADD', 'ZORPLIST', '1', []],
    ['ADD', 'NOPE', '1', ['x']],
  ]);
  assert.equal(lines[4].error, 'unknown type NOPE');
  const config = { servers: [{ id: 'main' }, { id: 'two' }] };
  assert.deepEqual(resolveServers(config, '1,2,9'), ['main', 'two']);
  assert.deepEqual(resolveServers(config, 'ALL'), ['main', 'two']);
  assert.deepEqual(resolveServers(config, 'two'), ['two']);
});

test('store deliveries wait for the link and the player, are delivered once and handled once per message', async () => {
  const t = await setup({ players: ['Dyn'], configure: config => { config.delivery.channelId = '700000000000000000'; } });
  try {
    const reactions = [];
    const message = {
      id: '800000000000000001', guildId: GUILD, channelId: '700000000000000000', author: { id: '900000000000000000', bot: true },
      content: [
        `[KAOS][ADD][<@${MEMBER}>][1]=[KIT][elitekit][2]`,
        `[KAOS][ADD][<@${MEMBER}>][1]=[POINTS][5000]`,
        `[KAOS][ADD][<@${MEMBER}>][1]=[ZORPLIST]`,
        `[KAOS][ADD][<@${MEMBER}>][1]=[KITLIST][elitekit]`,
      ].join('\n'),
      embeds: [], react: async emoji => reactions.push(emoji),
    };
    await t.runtime.deliveries.handleMessage(message);
    assert.deepEqual(reactions, ['✅']);
    assert.equal(t.economy.wallets.get(MEMBER), 5000);
    const lists = await data.getLists(t.discord.client, GUILD);
    assert.deepEqual(lists.zorp, [MEMBER]);
    assert.deepEqual(lists.kitLists.elitekit, [MEMBER]);
    assert.equal((await data.getDeliveries(t.discord.client, GUILD)).pending.length, 2);
    // The same message again (an edit or a resend) changes nothing.
    assert.deepEqual(await t.runtime.deliveries.handleMessage(message), { duplicate: true });
    assert.equal(t.economy.wallets.get(MEMBER), 5000);
    // A normal member cannot post delivery lines.
    assert.equal(await t.runtime.deliveries.handleMessage({ ...message, id: '800000000000000002', author: { id: OTHER, bot: false }, member: { permissions: { has: () => false } } }), null);

    await t.runtime.deliveries.processDue();
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 0, 'waits for the link');
    await data.setLink(t.discord.client, GUILD, MEMBER, 'Dylano');
    await t.runtime.deliveries.processDue();
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 0, 'waits until the player is online');
    t.game.players.push('Dylano');
    await t.refresh();
    assert.equal(t.game.sent.filter(command => command === 'kit givetoplayer "elitekit" "Dylano"').length, 2, 'delivered when Dylano joined');
    await t.runtime.deliveries.processDue();
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 2, 'never twice');
    const state = await data.getDeliveries(t.discord.client, GUILD);
    assert.equal(state.pending.length, 0);
    assert.deepEqual(state.done.map(entry => entry.status), ['delivered', 'delivered']);
  } finally { await t.close(); }
});

test('a delivery without an answer from the server is never sent again automatically', async () => {
  const t = await setup({ configure: config => { config.delivery.channelId = '700000000000000000'; } });
  try {
    await data.setLink(t.discord.client, GUILD, MEMBER, 'Dylano');
    t.game.fail = command => command.startsWith('kit givetoplayer');
    await t.runtime.deliveries.handleMessage({
      id: '800000000000000009', guildId: GUILD, channelId: '700000000000000000', webhookId: '1', author: { id: '900000000000000000' },
      content: `[KAOS][ADD][<@${MEMBER}>][1]=[KIT][elitekit][1]`, embeds: [], react: async () => undefined,
    });
    await settle(20);
    t.game.fail = null;
    await t.runtime.deliveries.processDue();
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 1);
    const state = await data.getDeliveries(t.discord.client, GUILD);
    assert.equal(state.done[0].status, 'needs_review');
    await t.runtime.deliveries.staffAction(GUILD, state.done[0].id, 'retry');
    await t.runtime.deliveries.processDue();
    assert.equal(t.game.sent.filter(command => command.startsWith('kit givetoplayer')).length, 2);
  } finally { await t.close(); }
});

// ------------------------------------------------------------------ slash commands

function fakeInteraction(t, { group = null, sub, options = {}, user = MEMBER, manage = true }) {
  const replies = [];
  const guild = t.discord.client.guilds.cache.get(GUILD);
  guild.members.me = { roles: { highest: { position: 50 } } };
  const channel = id => ({ id, permissionsFor: () => ({ has: () => true }) });
  return {
    client: t.discord.client, guildId: GUILD, guild, user: { id: user, username: 'tester' },
    member: { roles: { remove: async () => undefined }, permissions: { has: () => manage } },
    inGuild: () => true, replies,
    options: {
      getSubcommandGroup: () => group, getSubcommand: () => sub,
      getString: name => options[name] ?? null, getInteger: name => options[name] ?? null,
      getNumber: name => options[name] ?? null, getBoolean: name => options[name] ?? null,
      getUser: name => (options[name] ? { id: options[name] } : null), getRole: name => options[name] ?? null,
      getChannel: name => (options[name] ? channel(options[name]) : null),
      getFocused: () => ({ name: options.focused, value: '' }),
    },
    async deferReply() {}, async editReply(payload) { replies.push(payload); }, async reply(payload) { replies.push(payload); },
    async respond(choices) { replies.push({ choices }); },
  };
}

const titleOf = interaction => interaction.replies.at(-1)?.embeds?.[0]?.title;

test('every /rce, /rceconfig and /rust subcommand answers without errors', async () => {
  const rce = (await import('../src/commands/GameServer/rce.js')).default;
  const rceconfig = (await import('../src/commands/GameServer/rceconfig.js')).default;
  const rust = (await import('../src/commands/GameServer/rust.js')).default;
  const t = await setup({ teams: 'Team 42 member list:\nDylano [1001] (LEADER)\nDyn [1002]' });
  try {
    const run = async (command, spec, expected = 'Success') => {
      const interaction = fakeInteraction(t, spec);
      await command.execute(interaction);
      await settle(10);
      const title = titleOf(interaction);
      if (expected) assert.equal(title, expected, `${command.data.name} ${spec.group || ''} ${spec.sub}: ${JSON.stringify(interaction.replies.at(-1)?.embeds?.[0]?.description)}`);
      return interaction;
    };
    await run(rce, { group: 'server', sub: 'list' }, 'Rust servers');
    await run(rce, { group: 'channel', sub: 'set', options: { feed: 'events', channel: '500000000000000003' } });
    await run(rce, { group: 'channel', sub: 'list' }, 'Rust feed channels');
    await run(rce, { group: 'channel', sub: 'clear', options: { feed: 'events' } });
    await run(rce, { group: 'player', sub: 'kick', options: { server: 'main', player: 'Dyn' } });
    await run(rce, { group: 'player', sub: 'ban', options: { server: 'main', player: 'Dyn', minutes: 60 } });
    await run(rce, { group: 'player', sub: 'give', options: { server: 'main', player: 'Dyn', shortname: 'wood', amount: 500 } });
    await run(rce, { group: 'player', sub: 'give', options: { server: 'main', player: 'Dyn"; quit', shortname: 'wood' } }, 'Warning');
    await run(rce, { group: 'game', sub: 'say', options: { server: 'main', message: 'Hello' } });
    await run(rce, { group: 'game', sub: 'console', options: { server: 'main', command: 'serverinfo' } }, 'Console · Cloudy Rust');
    await run(rce, { group: 'game', sub: 'players', options: { server: 'main' } }, 'Online · Cloudy Rust');
    await run(rce, { group: 'game', sub: 'log', options: { server: 'main' } }, 'Console · Cloudy Rust');
    const status = await run(rce, { group: 'game', sub: 'status' }, null);
    assert.equal(status.replies.at(-1).embeds[0].title, 'Server status');
    assert.match(status.replies.at(-1).embeds[0].description, /Cloudy Rust\*\* Online/);
    await run(rce, { group: 'game', sub: 'wipe', options: { server: 'main', confirm: true } });
    await run(rce, { group: 'server', sub: 'reconnect', options: { server: 'main' } });
    await settle(20);
    await run(rce, { group: 'server', sub: 'edit', options: { server: 'main', name: 'Cloudy Rust EU' } });
    await run(rce, { group: 'server', sub: 'edit', options: { server: 'main' } }, 'Warning');

    await run(rceconfig, { sub: 'settings' }, 'Rust settings');
    await run(rceconfig, { sub: 'settings', options: { 'ingame-killfeed': true, welcome: 'Welcome {player}!' } }, 'Rust settings updated');
    await run(rceconfig, { sub: 'rewards', options: { kill: 10, 'playtime-hour': 60 } });
    await run(rceconfig, { group: 'shop', sub: 'add', options: { name: 'AK', type: 'item', price: 100, value: 'rifle.ak' } });
    await run(rceconfig, { group: 'shop', sub: 'add', options: { name: 'Bad', type: 'command', price: 1, value: 'say hi' } }, 'Warning');
    await run(rceconfig, { group: 'shop', sub: 'list' }, 'Rust shop');
    await run(rceconfig, { group: 'location', sub: 'add', options: { name: 'Outpost', x: 100, y: 10, z: 200 } });
    await run(rceconfig, { group: 'location', sub: 'list' }, 'Teleport locations');
    await run(rceconfig, { group: 'emote', sub: 'add', options: { emote: 'd11_quick_chat_responses_slot_5', action: 'kit', value: 'starter' } });
    await run(rceconfig, { group: 'emote', sub: 'add', options: { emote: 'd11_quick_chat_orders_slot_0', action: 'teleport', value: 'Outpost' } });
    await run(rceconfig, { group: 'emote', sub: 'add', options: { emote: 'nope', action: 'kit', value: 'starter' } }, 'Warning');
    await run(rceconfig, { group: 'emote', sub: 'list' }, 'Emote actions');
    await run(rceconfig, { group: 'automessage', sub: 'add', options: { text: 'Join our Discord!', minutes: 30 } });
    await run(rceconfig, { group: 'automessage', sub: 'list' }, 'Automatic messages');
    await run(rceconfig, { group: 'zorp', sub: 'settings', options: { enabled: true, radius: 40 } }, 'ZORP updated');
    await run(rceconfig, { group: 'zorp', sub: 'zones', options: { server: 'main' } }, 'ZORP zones · Cloudy Rust EU');
    await run(rceconfig, { group: 'access', sub: 'zorp', options: { member: OTHER } });
    await run(rceconfig, { group: 'access', sub: 'kit', options: { member: OTHER, kit: 'vipkit' } });
    await run(rceconfig, { group: 'access', sub: 'show', options: { member: OTHER } }, 'Rust access');
    await run(rceconfig, { group: 'link', sub: 'set', options: { member: MEMBER, gamertag: 'Dylano' } });
    await run(rceconfig, { group: 'link', sub: 'list' }, 'Linked members');
    await run(rceconfig, { group: 'delivery', sub: 'channel', options: { channel: '700000000000000000' } });
    await run(rceconfig, { group: 'delivery', sub: 'list' }, 'Store deliveries');

    const config = await store.getRceConfig(t.discord.client, GUILD, { fresh: true });
    assert.equal(config.shop.length, 1);
    assert.equal(config.emotes.length, 2);
    assert.equal(config.zorp.radius, 40);
    await run(rceconfig, { group: 'shop', sub: 'remove', options: { item: config.shop[0].id } });
    await run(rceconfig, { group: 'emote', sub: 'remove', options: { 'action-id': config.emotes[1].id } });
    await run(rceconfig, { group: 'automessage', sub: 'remove', options: { 'message-id': config.automessages[0].id } });
    await run(rceconfig, { group: 'location', sub: 'remove', options: { location: 'Outpost' } });

    await t.line('Dyn was killed by Dylano');
    await run(rust, { sub: 'profile' }, 'Rust profile');
    await run(rust, { sub: 'stats' }, 'Stats · Dylano');
    await run(rust, { sub: 'leaderboard', options: { type: 'kills' } }, 'Kills leaderboard');
    await run(rust, { sub: 'online' }, 'Online players');
    await run(rust, { sub: 'status' }, null);
    await run(rust, { sub: 'shop' }, 'Warning');
    await run(rust, { sub: 'zone' }, 'Warning');
    t.economy.wallets.set(MEMBER, 1000);
    await run(rust, { group: 'bounty', sub: 'place', options: { player: 'Dyn', amount: 200 } });
    await run(rust, { group: 'bounty', sub: 'list' }, 'Bounties');
    await run(rust, { sub: 'link', options: { gamertag: 'Dylano' }, user: OTHER }, 'Warning');
    await run(rust, { sub: 'link', options: { gamertag: 'NewPlayer' }, user: OTHER }, 'Link your account');
    await run(rust, { sub: 'unlink' });
    await run(rust, { sub: 'unlink' }, 'Warning');

    const auto = fakeInteraction(t, { sub: 'buy', options: { focused: 'server' } });
    await rust.autocomplete(auto);
    assert.deepEqual(auto.replies[0].choices.map(choice => choice.value), ['main']);
    const emotes = fakeInteraction(t, { sub: 'add', options: { focused: 'emote' } });
    await rceconfig.autocomplete(emotes);
    assert.equal(emotes.replies[0].choices.length, 25);
  } finally { await t.close(); }
});

test('Rust feed posts and answers skip the response-template layers, other embeds do not', async () => {
  const { isGameFeedEmbed } = await import('../src/services/gameFeedTitles.js');
  const embeds = await import('../src/services/rce/rceEmbeds.js');
  const event = parser.parseConsoleLine('Dyn was killed by Dylano');
  for (const embed of [
    embeds.killEmbed('Cloudy Rust', event), embeds.joinEmbed('Cloudy Rust', 'Dyn'), embeds.joinEmbed('Cloudy Rust', 'Dyn', { joined: false }),
    embeds.chatEmbed('Cloudy Rust', parser.parseConsoleLine('[CHAT TEAM] Dyn : d11_quick_chat_responses_slot_0')),
    embeds.worldEventEmbed('Cloudy Rust', 'Cargo Ship'), embeds.adminEmbed('Cloudy Rust', 'Kit given', []),
    embeds.zorpEmbed('Cloudy Rust', 'protected', { ownerName: 'Dyn', members: [] }),
    embeds.rceEmbed('Stats · Dyn', []), embeds.rceEmbed('Console · Cloudy Rust', []), embeds.rceEmbed('Kills leaderboard', []),
  ]) assert.equal(isGameFeedEmbed(embed), true, embed.title);
  assert.equal(isGameFeedEmbed(embeds.rceEmbed('Success', ['Done'])), false, 'status replies keep the normal 10-second handling');
  assert.equal(isGameFeedEmbed({ title: 'Reaction Role Removed', footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }), false);
  assert.equal(isGameFeedEmbed({ title: 'Kit given' }), false, 'only Cloudy-footer embeds');
});
