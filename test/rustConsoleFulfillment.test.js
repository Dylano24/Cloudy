import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKitCommand, normalizeGamertag, normalizePlatform, RustCommandError } from '../src/services/rustConsole/kitCommands.js';
import { createMockRcon, createRconClient, parseRconFrame, rconUrl, RconError } from '../src/services/rustConsole/rconClient.js';
import { createRustFulfillment, fulfillmentConfigFromEnv, parseChatFrame } from '../src/services/rustConsole/fulfillmentService.js';

const NOW = 1_800_000_000_000;
const BUYER = '222222222222222222';
const OWNER = '999999999999999999';
const quietLog = { info() {}, warn() {}, error() {} };

function memoryDb() {
  const map = new Map();
  return {
    map,
    get: async (key, fallback) => (map.has(key) ? structuredClone(map.get(key)) : fallback),
    set: async (key, value) => { map.set(key, structuredClone(value)); return true; },
    delete: async key => map.delete(key),
  };
}

function setup({ mode = 'mock', requireVerification = false, rcon = createMockRcon(), server = {} } = {}) {
  const db = memoryDb();
  let clock = NOW;
  const config = { mode, servers: { main: { host: 'example.com', port: 28016, password: 'pw', onlineCheckCommand: null, failurePattern: null, chatPattern: null, ...server } }, requireVerification, intervalMs: 30_000, offlineRetryMs: 300_000, maxWaitMs: 14 * 86_400_000, maxAttempts: 3 };
  const service = createRustFulfillment({ db, config, rconFor: () => rcon, now: () => clock, log: quietLog });
  return { db, service, rcon, advance: ms => { clock += ms; }, now: () => clock };
}

const order = (over = {}) => ({ orderKey: 'tip4serv:1:1:500:tx:payment.success', orderRef: 'tip4serv:1:1:500', paymentMode: 'test', server: 'main', platform: 'xbox', gamertag: 'Cloudy Player', discordId: BUYER, kits: [{ kit: 'starter', quantity: 2, productId: '42', name: 'Starter kit' }], ...over });

// ---------------------------------------------------------------- commands

test('gamertags and kit names are allow-listed, so no command can be injected', () => {
  assert.equal(normalizeGamertag('  Cloudy Player ', 'xbox'), 'Cloudy Player');
  assert.equal(normalizeGamertag('Cloudy#1234', 'xbox'), 'Cloudy#1234');
  assert.equal(normalizeGamertag('Cloudy_PS-5', 'playstation'), 'Cloudy_PS-5');
  for (const bad of ['a"; ban all', 'name\nquit', 'two  spaces', '', 'x'.repeat(20), 'semi;colon', 'quote"']) {
    assert.throws(() => normalizeGamertag(bad, 'xbox'), RustCommandError, bad);
  }
  assert.throws(() => normalizeGamertag('1startsWithDigit', 'playstation'), RustCommandError);
  assert.throws(() => normalizeGamertag('ok', 'pc'), RustCommandError);
  assert.throws(() => buildKitCommand('vip" ; quit', 'Cloudy', 'xbox'), RustCommandError);
  assert.equal(buildKitCommand('vip_kit', 'Cloudy Player', 'xbox'), 'kit givetoplayer "vip_kit" "Cloudy Player"');
  assert.equal(normalizePlatform('PS5'), 'playstation');
  assert.equal(normalizePlatform('XBL'), 'xbox');
  assert.equal(normalizePlatform('switch'), null);
});

// ---------------------------------------------------------------- RCON client

class FakeSocket {
  static last = null;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.last = this; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

test('the RCON client puts the password in the path and matches replies on their identifier', async () => {
  assert.equal(rconUrl({ host: 'rce.example.com', port: 28016, password: 'p/w ?' }), 'ws://rce.example.com:28016/p%2Fw%20%3F');
  assert.throws(() => rconUrl({ host: 'bad host', port: 1, password: 'x' }), RconError);
  const client = createRconClient({ host: 'rce.example.com', port: 28016, password: 'pw', WebSocketImpl: FakeSocket, timeoutMs: 200 });
  const chatter = [];
  client.onMessage(frame => chatter.push(frame));
  const pending = client.send('serverinfo');
  await new Promise(resolve => setTimeout(resolve, 5));
  const socket = FakeSocket.last;
  const { identifier, name, message } = socket.sent[0];
  assert.equal(message, 'serverinfo');
  assert.equal(name, 'Cloudy');
  socket.reply({ identifier: 0, message: '[CHAT] someone : hello' });
  socket.reply({ Identifier: identifier, Message: 'Hostname: Cloudy Rust' });
  assert.equal(await pending, 'Hostname: Cloudy Rust');
  assert.equal(chatter.length, 1, 'broadcast lines go to listeners, not to the command');
  await assert.rejects(client.send('bad\ncommand'), /Invalid command/);
  await assert.rejects(client.send('status'), error => error.code === 'timeout');
  client.close();
  assert.deepEqual(parseRconFrame('not json'), null);
});

// ---------------------------------------------------------------- queue

test('kit delivery is off by default and refuses everything', async () => {
  const config = fulfillmentConfigFromEnv({}, quietLog);
  assert.equal(config.mode, 'off');
  const { service } = setup({ mode: 'off' });
  await assert.rejects(service.enqueue(order()), error => error.code === 'not_enabled' && error.status === 503);
  assert.equal(fulfillmentConfigFromEnv({ RUST_CONSOLE_FULFILLMENT: 'live', RUST_CONSOLE_SERVERS: '{bad json' }, quietLog).mode, 'off');
  const parsed = fulfillmentConfigFromEnv({ RUST_CONSOLE_FULFILLMENT: 'live', RUST_CONSOLE_SERVERS: '{"main":{"host":"1.2.3.4","port":28016}}', RUST_CONSOLE_RCON_PASSWORD_MAIN: 'secret' }, quietLog);
  assert.equal(parsed.servers.main.password, 'secret', 'the password only comes from its own variable');
});

test('mock delivery never accepts a real payment', async () => {
  const { service } = setup();
  await assert.rejects(service.enqueue(order({ paymentMode: 'live' })), error => error.code === 'mock_live_refused');
});

test('an order is queued once per kit unit and delivered exactly once, also when the webhook repeats', async () => {
  const { service, rcon } = setup();
  const first = await service.enqueue(order());
  assert.equal(first.deliveries.length, 2);
  assert.deepEqual(first.deliveries.map(row => row.status), ['queued', 'queued']);
  const again = await service.enqueue(order());
  assert.deepEqual(again.deliveries.map(row => row.id), first.deliveries.map(row => row.id));

  assert.equal((await service.processDue()).processed, 2);
  assert.deepEqual(rcon.sent, ['kit givetoplayer "starter" "Cloudy Player"', 'kit givetoplayer "starter" "Cloudy Player"']);
  assert.equal((await service.processDue()).processed, 0, 'delivered kits are never sent again');
  await service.enqueue(order());
  await service.processDue();
  assert.equal(rcon.sent.length, 2);
  const { deliveries, counts } = await service.list();
  assert.equal(counts.delivered, 2);
  assert.equal(deliveries[0].confirmation, 'mock');
});

test('invalid orders are refused before anything is stored', async () => {
  const { service, db } = setup();
  await assert.rejects(service.enqueue(order({ gamertag: 'x"; quit' })), error => error.code === 'invalid_gamertag');
  await assert.rejects(service.enqueue(order({ server: 'other' })), error => error.code === 'unknown_server');
  await assert.rejects(service.enqueue(order({ kits: [{ kit: 'starter', quantity: 21 }] })), error => error.code === 'invalid');
  await assert.rejects(service.enqueue(order({ platform: 'pc' })), error => error.code === 'invalid_platform');
  assert.equal(db.map.size, 0);
});

test('a lost answer after sending goes to staff review and is never resent automatically', async () => {
  let calls = 0;
  const rcon = createMockRcon({ reply: () => { calls++; throw new RconError('RCON command timed out.', 'timeout'); } });
  const { service } = setup({ rcon });
  await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  await service.processDue();
  const [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'needs_review');
  await service.processDue();
  assert.equal(calls, 1);
});

test('a server that refuses the command is retried with backoff and then fails', async () => {
  const rcon = createMockRcon({ reply: () => 'Kit not found' });
  const { service, advance } = setup({ rcon });
  await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  await service.processDue();
  let [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'queued');
  assert.match(delivery.lastError, /server_rejected/);
  assert.equal((await service.processDue()).processed, 0, 'waits for the backoff');
  for (let i = 0; i < 5; i++) { advance(3_600_000); await service.processDue(); }
  [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attempts, 3);
});

test('an unreachable server keeps the order and backs off without using up attempts', async () => {
  const rcon = { ...createMockRcon(), connect: async () => { throw new RconError('RCON connection failed.', 'connect_failed'); } };
  const { service, advance } = setup({ rcon });
  await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  await service.processDue();
  let [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'queued');
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.connectFailures, 1);
  advance(15 * 86_400_000);
  await service.processDue();
  [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'failed');
});

test('an offline player keeps the order until they come online', async () => {
  const online = new Set();
  const rcon = createMockRcon({ online });
  const { service, advance } = setup({ rcon, server: { onlineCheckCommand: 'playerlist' } });
  await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  await service.processDue();
  let [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'queued');
  assert.equal(delivery.waitingForPlayer, true);
  assert.equal(rcon.sent.filter(command => command.startsWith('kit')).length, 0);
  online.add('Cloudy Player');
  advance(300_001);
  await service.processDue();
  [delivery] = (await service.list()).deliveries;
  assert.equal(delivery.status, 'delivered');
});

test('a restart during sending marks the delivery for review', async () => {
  const { service, db } = setup();
  const { deliveries } = await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  const key = `rust-console:delivery:${deliveries[0].id}`;
  db.map.set(key, { ...db.map.get(key), status: 'delivering' });
  await service.recoverInterrupted();
  assert.equal(db.map.get(key).status, 'needs_review');
});

test('refunds cancel what was not delivered and flag what was', async () => {
  const { service } = setup();
  await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  await service.processDue();
  await service.enqueue(order({ orderKey: 'tip4serv:1:1:500:tx:payment.success:2', kits: [{ kit: 'vip', quantity: 1 }] }));
  const summary = await service.refund('tip4serv:1:1:500');
  assert.deepEqual(summary, { found: 2, cancelled: 1, alreadyDelivered: 1, unchanged: 0 });
  const { counts } = await service.list();
  assert.deepEqual(counts, { refunded_after_delivery: 1, cancelled: 1 });
  assert.deepEqual(await service.refund('tip4serv:1:1:500'), { found: 2, cancelled: 0, alreadyDelivered: 0, unchanged: 2 });
});

// ---------------------------------------------------------------- verification

test('gamertag verification: the code must be typed in game by that gamertag', async () => {
  const rcon = createMockRcon();
  const { service } = setup({ requireVerification: true, rcon });
  const queued = await service.enqueue(order({ kits: [{ kit: 'starter', quantity: 1 }] }));
  assert.equal(queued.deliveries[0].status, 'awaiting_verification');
  assert.equal((await service.processDue()).processed, 0);

  const { code } = await service.startVerification(BUYER, 'xbox', 'Cloudy Player');
  assert.match(code, /^CLOUDY-[A-HJ-NP-Z2-9]{6}$/);
  // Someone else typing the code changes nothing.
  assert.equal(await service.handleChatFrame('main', { message: `[CHAT] Impostor : ${code}` }), null);
  assert.equal((await service.verificationStatus(BUYER)).link, null);
  const link = await service.handleChatFrame('main', { type: 'Chat', message: JSON.stringify({ Username: 'cloudy player', Message: `my code ${code.toLowerCase()}` }) });
  assert.equal(link.gamertag, 'Cloudy Player');
  assert.equal((await service.verificationStatus(BUYER)).link.platform, 'xbox');
  // The code works once.
  assert.equal(await service.handleChatFrame('main', { message: `[CHAT] Cloudy Player : ${code}` }), null);

  await service.processDue();
  assert.deepEqual(rcon.sent, ['kit givetoplayer "starter" "Cloudy Player"']);
});

test('verification codes expire and are rate limited', async () => {
  const { service, advance } = setup({ requireVerification: true });
  const { code } = await service.startVerification(BUYER, 'playstation', 'CloudyPS');
  advance(16 * 60_000);
  assert.equal(await service.handleChatFrame('main', { message: `[CHAT] CloudyPS : ${code}` }), null);
  for (let i = 0; i < 4; i++) await service.startVerification(BUYER, 'playstation', 'CloudyPS');
  await assert.rejects(service.startVerification(BUYER, 'playstation', 'CloudyPS'), error => error.code === 'rate_limited');
  await assert.rejects(service.startVerification('nope', 'playstation', 'CloudyPS'), error => error.code === 'unauthorized');
});

test('chat lines are recognised in Rust\'s formats', () => {
  assert.deepEqual(parseChatFrame({ message: '[CHAT] Cloudy Player : hi there' }), { name: 'Cloudy Player', text: 'hi there' });
  assert.deepEqual(parseChatFrame({ type: 'Chat', message: '{"Username":"A","Message":"b"}' }), { name: 'A', text: 'b' });
  assert.equal(parseChatFrame({ message: 'Saving 1234 entities' }), null);
  assert.deepEqual(parseChatFrame({ message: 'A says: hello' }, /^(?<name>\w+) says: (?<text>.+)$/), { name: 'A', text: 'hello' });
});

// ---------------------------------------------------------------- HTTP

test('staff routes need Cloudy\'s owner; customers verify only themselves', async () => {
  const { service } = setup({ requireVerification: true });
  const responses = [];
  const send = (status, body) => { responses.push({ status, body }); return { status, body }; };
  const isStaff = async id => id === OWNER;
  const call = (method, route, payload, actorId) => service.handle({ req: { method }, route, payload, send, actorId, isStaff });

  assert.equal((await call('POST', ['deliveries', 'query'], {}, BUYER)).status, 403);
  assert.equal((await call('POST', ['deliveries', 'query'], {}, OWNER)).status, 200);
  const started = await call('POST', ['verify', 'start'], { platform: 'xbox', gamertag: 'Cloudy Player', discordId: OWNER }, BUYER);
  assert.equal(started.status, 200);
  assert.equal((await service.verificationStatus(BUYER)).pending, true, 'the signed actor is used, never a discordId in the body');
  assert.equal((await service.verificationStatus(OWNER)).pending, false);
  const status = await call('GET', ['status'], {}, BUYER);
  assert.deepEqual(status.body.servers, ['main']);
  assert.equal(JSON.stringify(status.body).includes('pw'), false, 'passwords are never returned');
  assert.equal((await call('POST', ['orders'], { bad: true }, BUYER)).status, 422);
  const queued = await call('POST', ['orders'], order({ kits: [{ kit: 'starter', quantity: 1 }] }), BUYER);
  const id = queued.body.deliveries[0].id;
  assert.equal((await call('POST', ['deliveries', id, 'retry'], {}, OWNER)).status, 409);
  assert.equal((await call('POST', ['deliveries', id, 'cancel'], {}, OWNER)).body.delivery.status, 'cancelled');
});
