// Automatic kit delivery for Rust Console Edition, bought on Cloudy Store.
//
// Disabled unless RUST_CONSOLE_FULFILLMENT is "mock" or "live". The website
// sends each verified, paid order here over the signed dashboard connection;
// every kit unit becomes one delivery with a stable ID, so a webhook retry or
// resend never delivers twice. A delivery is sent at most once: when a command
// may have reached the server but no answer came back, it is marked
// needs_review for staff instead of being sent again.
//
// Statuses: awaiting_verification -> queued -> delivering -> delivered, or
// failed / needs_review / cancelled / refunded_after_delivery.

import { createHash, randomInt } from 'node:crypto';
import { logger as defaultLogger } from '../../utils/logger.js';
import { PLATFORMS, RustCommandError, buildKitCommand, normalizeGamertag, normalizeKitName, normalizePlatform, playerKey } from './kitCommands.js';
import { RconError, createMockRcon, createRconClient } from './rconClient.js';

const KEY = 'rust-console';
const INDEX_KEY = `${KEY}:deliveries`;
const AUDIT_KEY = `${KEY}:audit`;
const deliveryKey = id => `${KEY}:delivery:${id}`;
const orderKeyOf = ref => `${KEY}:order:${createHash('sha256').update(ref).digest('hex').slice(0, 32)}`;
const linkKey = discordId => `${KEY}:link:${discordId}`;
const verifyKey = discordId => `${KEY}:verify:${discordId}`;
const codeKey = code => `${KEY}:verify-code:${createHash('sha256').update(code).digest('hex').slice(0, 32)}`;

const SNOWFLAKE = /^\d{17,20}$/;
const ORDER_KEY = /^[A-Za-z0-9:._-]{8,200}$/;
const INDEX_LIMIT = 5_000;
const AUDIT_LIMIT = 500;
const MAX_UNITS = 50;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /\bCLOUDY-([A-HJ-NP-Z2-9]{6})\b/i;
const VERIFY_TTL_MS = 15 * 60_000;
const VERIFY_STARTS_PER_HOUR = 5;
const FINAL = new Set(['delivered', 'cancelled', 'refunded_after_delivery']);
const DEFAULT_FAILURE = /(not found|no player|unknown (?:kit|player|command)|invalid|does not exist|failed|error)/i;

export const DELIVERY_STATUSES = Object.freeze(['awaiting_verification', 'queued', 'delivering', 'delivered', 'failed', 'needs_review', 'cancelled', 'refunded_after_delivery']);

export class FulfillmentError extends Error {
  constructor(message, code, status = 422) {
    super(message);
    this.name = 'FulfillmentError';
    this.code = code;
    this.status = status;
  }
}

/** Reads the configuration from the environment. Never throws: a bad value means "off". */
export function fulfillmentConfigFromEnv(env = process.env, log = defaultLogger) {
  const mode = ['mock', 'live'].includes(String(env.RUST_CONSOLE_FULFILLMENT || '').trim()) ? String(env.RUST_CONSOLE_FULFILLMENT).trim() : 'off';
  const servers = {};
  if (mode !== 'off') {
    try {
      const parsed = JSON.parse(env.RUST_CONSOLE_SERVERS || '{}');
      for (const [name, value] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
        if (!/^[a-z0-9_-]{1,32}$/.test(name) || !value || typeof value !== 'object') continue;
        servers[name] = {
          host: String(value.host || ''),
          port: Number(value.port),
          tls: value.tls === true,
          password: String(env[`RUST_CONSOLE_RCON_PASSWORD_${name.toUpperCase().replace(/-/g, '_')}`] || ''),
          onlineCheckCommand: typeof value.onlineCheckCommand === 'string' && /^[a-z.]{1,32}$/.test(value.onlineCheckCommand) ? value.onlineCheckCommand : null,
          failurePattern: typeof value.failurePattern === 'string' ? safeRegex(value.failurePattern) : null,
          chatPattern: typeof value.chatPattern === 'string' ? safeRegex(value.chatPattern) : null,
        };
      }
    } catch (error) {
      log.warn('[RUST] RUST_CONSOLE_SERVERS is not valid JSON; kit delivery stays off:', error?.message);
      return { mode: 'off', servers: {} };
    }
  }
  return {
    mode,
    servers,
    requireVerification: String(env.RUST_CONSOLE_REQUIRE_VERIFICATION || 'true') !== 'false',
    intervalMs: 30_000,
    offlineRetryMs: 5 * 60_000,
    maxWaitMs: 14 * 86_400_000,
    maxAttempts: 8,
  };
}

function safeRegex(source) {
  try { return source.length <= 300 ? new RegExp(source, 'i') : null; } catch { return null; }
}

/** Finds a chat line in a frame: Rust's own Chat frame, a configured pattern, or "[CHAT] name : text". */
export function parseChatFrame(frame, pattern = null) {
  if (!frame?.message) return null;
  if (/^chat$/i.test(frame.type || '')) {
    try {
      const chat = JSON.parse(frame.message);
      if (typeof chat?.Username === 'string' && typeof chat?.Message === 'string') return { name: chat.Username, text: chat.Message };
    } catch { /* not JSON: try the text forms */ }
  }
  const match = (pattern || /^\s*\[(?:CHAT|GLOBAL|TEAM)[^\]]*\]\s*(?<name>[^:\]]{1,40}?)\s*:\s*(?<text>.+)$/i).exec(frame.message);
  if (!match?.groups?.name || !match?.groups?.text) return null;
  return { name: match.groups.name.trim(), text: match.groups.text.trim() };
}

function newCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const backoffMs = attempts => Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;

export function createRustFulfillment({ db, config, isReady = () => true, rconFor = null, now = () => Date.now(), log = defaultLogger }) {
  const store = () => (typeof db === 'function' ? db() : db);
  const connections = new Map();
  const chatAttached = new Set();
  let running = false;
  let timer = null;

  function connection(serverName) {
    if (connections.has(serverName)) return connections.get(serverName);
    const server = config.servers[serverName];
    const rcon = rconFor ? rconFor(serverName, server) : config.mode === 'mock' ? createMockRcon() : createRconClient({ ...server, name: 'Cloudy' });
    connections.set(serverName, rcon);
    return rcon;
  }
  function dropConnection(serverName) {
    const rcon = connections.get(serverName);
    connections.delete(serverName);
    chatAttached.delete(serverName);
    try { rcon?.close?.(); } catch { /* closed */ }
  }

  async function audit(entry) {
    try {
      const list = await store().get(AUDIT_KEY, []);
      await store().set(AUDIT_KEY, [{ at: new Date(now()).toISOString(), ...entry }, ...(Array.isArray(list) ? list : [])].slice(0, AUDIT_LIMIT));
    } catch (error) {
      log.warn('[RUST] Could not store audit entry:', error?.message);
    }
  }
  async function save(delivery, note) {
    const at = new Date(now()).toISOString();
    const next = { ...delivery, updatedAt: at, history: [...(delivery.history || []), { at, status: delivery.status, ...(note ? { note } : {}) }].slice(-30) };
    await store().set(deliveryKey(delivery.id), next);
    return next;
  }
  async function load(id) {
    return store().get(deliveryKey(id), null);
  }
  async function index() {
    const list = await store().get(INDEX_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  async function all() {
    const ids = await index();
    const rows = [];
    for (const id of ids) { const row = await load(id); if (row) rows.push(row); }
    return rows;
  }
  async function linked(discordId, platform, gamertag) {
    if (!discordId) return false;
    const link = await store().get(linkKey(discordId), null);
    return Boolean(link && link.platform === platform && playerKey(link.platform, link.gamertag) === playerKey(platform, gamertag));
  }

  function enabled() {
    if (config.mode === 'off') throw new FulfillmentError('Rust Console kit delivery is not enabled.', 'not_enabled', 503);
  }

  // ------------------------------------------------------------ orders

  async function enqueue(order) {
    enabled();
    const input = order && typeof order === 'object' ? order : {};
    if (typeof input.orderKey !== 'string' || !ORDER_KEY.test(input.orderKey)) throw new FulfillmentError('Invalid order key.', 'invalid');
    if (typeof input.orderRef !== 'string' || !ORDER_KEY.test(input.orderRef)) throw new FulfillmentError('Invalid order reference.', 'invalid');
    const paymentMode = input.paymentMode === 'live' ? 'live' : input.paymentMode === 'test' ? 'test' : null;
    if (!paymentMode) throw new FulfillmentError('Invalid payment mode.', 'invalid');
    if (config.mode === 'mock' && paymentMode === 'live') throw new FulfillmentError('Mock delivery never accepts real payments.', 'mock_live_refused', 409);
    const serverName = String(input.server || '');
    if (!config.servers[serverName]) throw new FulfillmentError('Unknown game server.', 'unknown_server');
    const platform = normalizePlatform(input.platform);
    if (!platform) throw new FulfillmentError(`Choose ${PLATFORMS.join(' or ')}.`, 'invalid_platform');
    let gamertag;
    try { gamertag = normalizeGamertag(input.gamertag, platform); } catch (error) { throw new FulfillmentError(error.message, error.code); }
    const discordId = typeof input.discordId === 'string' && SNOWFLAKE.test(input.discordId) ? input.discordId : null;
    const kits = Array.isArray(input.kits) ? input.kits : [];
    if (!kits.length) throw new FulfillmentError('No kits in this order.', 'invalid');
    const units = [];
    kits.forEach((item, itemIndex) => {
      let kit;
      try { kit = normalizeKitName(item?.kit); } catch (error) { throw new FulfillmentError(error.message, error.code); }
      const quantity = item?.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new FulfillmentError('Invalid quantity.', 'invalid');
      for (let unit = 0; unit < quantity; unit++) units.push({ kit, itemIndex, unit, productId: String(item?.productId ?? '').slice(0, 64), label: String(item?.name ?? kit).slice(0, 100) });
    });
    if (units.length > MAX_UNITS) throw new FulfillmentError('Too many kits in one order.', 'invalid');

    const verified = !config.requireVerification || await linked(discordId, platform, gamertag);
    const ids = await index();
    const orderIds = await store().get(orderKeyOf(input.orderRef), []);
    const result = [];
    let created = 0;
    for (const unit of units) {
      const id = createHash('sha256').update(`${input.orderKey}|${unit.itemIndex}|${unit.unit}`).digest('hex').slice(0, 24);
      const existing = await load(id);
      if (existing) { result.push({ id, status: existing.status, kit: existing.kit }); continue; }
      const at = new Date(now()).toISOString();
      const delivery = await save({
        id, orderRef: input.orderRef, orderKey: input.orderKey, paymentMode, server: serverName, platform, gamertag, discordId,
        kit: unit.kit, productId: unit.productId, label: unit.label,
        status: verified ? 'queued' : 'awaiting_verification', attempts: 0, nextAttemptAt: at, createdAt: at, history: [],
      }, verified ? 'paid' : 'paid; waiting for gamertag verification');
      ids.push(id);
      orderIds.push(id);
      created++;
      result.push({ id, status: delivery.status, kit: delivery.kit });
    }
    if (created) {
      await store().set(orderKeyOf(input.orderRef), [...new Set(orderIds)]);
      await store().set(INDEX_KEY, trimIndex(ids));
      await audit({ action: 'order', orderRef: input.orderRef, server: serverName, units: created, verified });
      log.info(`[RUST] Queued ${created} kit deliveries for ${platform} player on ${serverName} (${input.orderRef})`);
    }
    return { deliveries: result, verified };
  }

  function trimIndex(ids) {
    const unique = [...new Set(ids)];
    return unique.length > INDEX_LIMIT ? unique.slice(unique.length - INDEX_LIMIT) : unique;
  }

  async function refund(orderRef, actor = 'store') {
    enabled();
    if (typeof orderRef !== 'string' || !ORDER_KEY.test(orderRef)) throw new FulfillmentError('Invalid order reference.', 'invalid');
    const ids = await store().get(orderKeyOf(orderRef), []);
    const summary = { cancelled: 0, alreadyDelivered: 0, unchanged: 0 };
    for (const id of ids) {
      const delivery = await load(id);
      if (!delivery) continue;
      if (delivery.status === 'delivered') {
        await save({ ...delivery, status: 'refunded_after_delivery' }, 'refunded after the kit was delivered: check in game');
        summary.alreadyDelivered++;
      } else if (FINAL.has(delivery.status) || delivery.status === 'delivering') {
        summary.unchanged++;
      } else {
        await save({ ...delivery, status: 'cancelled' }, 'refunded');
        summary.cancelled++;
      }
    }
    if (summary.cancelled || summary.alreadyDelivered) {
      await audit({ action: 'refund', orderRef, actor, ...summary });
      if (summary.alreadyDelivered) log.warn(`[RUST] Refund for ${orderRef} after ${summary.alreadyDelivered} kit(s) were delivered: staff should review`);
    }
    return { found: ids.length, ...summary };
  }

  // ------------------------------------------------------------ delivery

  async function recoverInterrupted() {
    for (const delivery of await all()) {
      if (delivery.status === 'delivering') {
        await save({ ...delivery, status: 'needs_review' }, 'Cloudy restarted while sending: check in game before retrying');
        log.warn(`[RUST] Delivery ${delivery.id} was interrupted by a restart and needs review`);
      }
    }
  }

  async function deliverOne(delivery) {
    const server = config.servers[delivery.server];
    if (!server) return save({ ...delivery, status: 'failed', lastError: 'unknown_server' }, 'game server is no longer configured');
    const rcon = connection(delivery.server);
    try {
      await rcon.connect();
      await attachChat(delivery.server, rcon);
      if (server.onlineCheckCommand) {
        const players = await rcon.send(server.onlineCheckCommand);
        if (!String(players).toLowerCase().includes(delivery.gamertag.toLowerCase())) {
          if (now() - Date.parse(delivery.createdAt) > config.maxWaitMs) return save({ ...delivery, status: 'failed', lastError: 'player_offline_timeout' }, 'player was not online within the delivery window');
          return save({ ...delivery, nextAttemptAt: new Date(now() + config.offlineRetryMs).toISOString(), waitingForPlayer: true }, null);
        }
      }
    } catch (error) {
      // Nothing was sent yet: safe to try again later. A server that is down
      // keeps its orders until the delivery window ends, with growing pauses.
      dropConnection(delivery.server);
      const reason = error instanceof RconError ? error.code : 'connect_failed';
      if (now() - Date.parse(delivery.createdAt) > config.maxWaitMs) return save({ ...delivery, status: 'failed', lastError: reason }, 'game server could not be reached within the delivery window');
      const failures = (delivery.connectFailures || 0) + 1;
      return save({ ...delivery, connectFailures: failures, lastError: reason, nextAttemptAt: new Date(now() + backoffMs(failures)).toISOString() }, null);
    }

    let command;
    try { command = buildKitCommand(delivery.kit, delivery.gamertag, delivery.platform); } catch (error) {
      return save({ ...delivery, status: 'failed', lastError: error instanceof RustCommandError ? error.code : 'invalid' }, 'invalid kit or gamertag');
    }
    const sending = await save({ ...delivery, status: 'delivering', attempts: delivery.attempts + 1, waitingForPlayer: false }, null);
    let reply;
    try {
      reply = await rcon.send(command);
    } catch (error) {
      dropConnection(delivery.server);
      if (error instanceof RconError && ['invalid_command', 'send_failed'].includes(error.code)) return retryLater(sending, error.code);
      // The command may have reached the server: never send it again automatically.
      return save({ ...sending, status: 'needs_review', lastError: error instanceof RconError ? error.code : 'unknown' }, 'no answer from the server after sending: check in game');
    }
    const failure = server.failurePattern || DEFAULT_FAILURE;
    if (failure.test(String(reply))) return retryLater(sending, `server_rejected: ${String(reply).slice(0, 160)}`);
    const done = await save({ ...sending, status: 'delivered', deliveredAt: new Date(now()).toISOString(), confirmation: config.mode === 'mock' ? 'mock' : 'rcon-accepted', lastReply: String(reply).slice(0, 200) }, null);
    await audit({ action: 'delivered', id: done.id, orderRef: done.orderRef, server: done.server, kit: done.kit, mode: config.mode });
    return done;
  }

  async function retryLater(delivery, reason) {
    const attempts = delivery.attempts || 0;
    if (attempts >= config.maxAttempts) {
      log.warn(`[RUST] Delivery ${delivery.id} failed after ${attempts} attempts: ${reason}`);
      return save({ ...delivery, status: 'failed', lastError: reason }, 'gave up after repeated failures');
    }
    return save({ ...delivery, status: 'queued', lastError: reason, nextAttemptAt: new Date(now() + backoffMs(attempts + 1)).toISOString() }, null);
  }

  async function processDue() {
    if (config.mode === 'off' || running || !isReady()) return { processed: 0 };
    if (store()?.getStatus?.()?.isDegraded === true) return { processed: 0 };
    running = true;
    let processed = 0;
    try {
      for (const delivery of await all()) {
        if (delivery.status !== 'queued' || Date.parse(delivery.nextAttemptAt) > now()) continue;
        await deliverOne(delivery);
        processed++;
      }
    } catch (error) {
      log.error('[RUST] Delivery run failed:', error);
    } finally {
      running = false;
    }
    return { processed };
  }

  // ------------------------------------------------------------ verification

  async function attachChat(serverName, rcon) {
    if (chatAttached.has(serverName) || typeof rcon.onMessage !== 'function') return;
    chatAttached.add(serverName);
    rcon.onMessage(frame => { void handleChatFrame(serverName, frame); });
  }

  async function startVerification(discordId, platformInput, gamertagInput) {
    enabled();
    if (!SNOWFLAKE.test(String(discordId || ''))) throw new FulfillmentError('Sign in with Discord first.', 'unauthorized', 401);
    const platform = normalizePlatform(platformInput);
    if (!platform) throw new FulfillmentError(`Choose ${PLATFORMS.join(' or ')}.`, 'invalid_platform');
    let gamertag;
    try { gamertag = normalizeGamertag(gamertagInput, platform); } catch (error) { throw new FulfillmentError(error.message, error.code); }
    const previous = await store().get(verifyKey(discordId), null);
    const recent = (Array.isArray(previous?.starts) ? previous.starts : []).filter(at => now() - at < 3_600_000);
    if (recent.length >= VERIFY_STARTS_PER_HOUR) throw new FulfillmentError('Too many attempts. Try again in an hour.', 'rate_limited', 429);
    const code = newCode();
    const expiresAt = now() + VERIFY_TTL_MS;
    await store().set(verifyKey(discordId), { platform, gamertag, codeHash: createHash('sha256').update(code).digest('hex'), expiresAt, starts: [...recent, now()] });
    await store().set(codeKey(code), { discordId, expiresAt });
    return { code: `CLOUDY-${code}`, expiresAt: new Date(expiresAt).toISOString(), platform, gamertag };
  }

  async function handleChatFrame(serverName, frame) {
    try {
      const chat = parseChatFrame(frame, config.servers[serverName]?.chatPattern || null);
      const match = chat ? CODE_PATTERN.exec(chat.text) : null;
      if (!match) return null;
      const code = match[1].toUpperCase();
      const pointer = await store().get(codeKey(code), null);
      if (!pointer || pointer.expiresAt < now()) return null;
      const pending = await store().get(verifyKey(pointer.discordId), null);
      if (!pending || pending.expiresAt < now() || pending.codeHash !== createHash('sha256').update(code).digest('hex')) return null;
      // The code must come from the gamertag that asked for it.
      if (chat.name.toLowerCase() !== pending.gamertag.toLowerCase()) return null;
      const link = { platform: pending.platform, gamertag: pending.gamertag, verifiedAt: new Date(now()).toISOString(), server: serverName };
      await store().set(linkKey(pointer.discordId), link);
      await store().set(verifyKey(pointer.discordId), { starts: pending.starts || [] });
      await store().delete(codeKey(code)).catch(() => undefined);
      await audit({ action: 'verified', platform: link.platform, server: serverName });
      await releaseAwaiting(pointer.discordId, link);
      log.info(`[RUST] Verified a ${link.platform} gamertag for a Cloudy Store customer on ${serverName}`);
      return link;
    } catch (error) {
      log.warn('[RUST] Could not handle a chat line:', error?.message);
      return null;
    }
  }

  async function releaseAwaiting(discordId, link) {
    for (const delivery of await all()) {
      if (delivery.status !== 'awaiting_verification' || delivery.discordId !== discordId) continue;
      if (playerKey(delivery.platform, delivery.gamertag) !== playerKey(link.platform, link.gamertag)) continue;
      await save({ ...delivery, status: 'queued', nextAttemptAt: new Date(now()).toISOString() }, 'gamertag verified');
    }
  }

  async function verificationStatus(discordId) {
    const link = await store().get(linkKey(discordId), null);
    const pending = await store().get(verifyKey(discordId), null);
    return { link: link ? { platform: link.platform, gamertag: link.gamertag, verifiedAt: link.verifiedAt } : null, pending: Boolean(pending?.codeHash && pending.expiresAt > now()) };
  }

  // ------------------------------------------------------------ staff

  async function list({ status = null, limit = 100 } = {}) {
    const everything = await all();
    const rows = everything.filter(row => !status || row.status === status).reverse().slice(0, Math.min(500, Math.max(1, limit)));
    const counts = {};
    for (const row of everything) counts[row.status] = (counts[row.status] || 0) + 1;
    return { deliveries: rows.map(({ history, ...row }) => ({ ...row, history: (history || []).slice(-10) })), counts };
  }

  async function staffAction(id, action, actor) {
    const delivery = await load(id);
    if (!delivery) throw new FulfillmentError('Delivery not found.', 'not_found', 404);
    if (action === 'retry') {
      if (!['failed', 'needs_review'].includes(delivery.status)) throw new FulfillmentError('Only failed or reviewed deliveries can be retried.', 'invalid_state', 409);
      const next = await save({ ...delivery, status: 'queued', attempts: 0, nextAttemptAt: new Date(now()).toISOString(), lastError: null }, `retried by staff ${actor}`);
      await audit({ action: 'retry', id, actor });
      return next;
    }
    if (action === 'cancel') {
      if (FINAL.has(delivery.status) || delivery.status === 'delivering') throw new FulfillmentError('This delivery cannot be cancelled now.', 'invalid_state', 409);
      const next = await save({ ...delivery, status: 'cancelled' }, `cancelled by staff ${actor}`);
      await audit({ action: 'cancel', id, actor });
      return next;
    }
    if (action === 'mark-delivered') {
      if (delivery.status !== 'needs_review') throw new FulfillmentError('Only reviewed deliveries can be marked delivered.', 'invalid_state', 409);
      const next = await save({ ...delivery, status: 'delivered', deliveredAt: new Date(now()).toISOString(), confirmation: 'staff' }, `confirmed in game by staff ${actor}`);
      await audit({ action: 'mark-delivered', id, actor });
      return next;
    }
    throw new FulfillmentError('Unknown action.', 'unknown_action', 404);
  }

  // ------------------------------------------------------------ HTTP

  /** Route handler used by the signed dashboard connection (billing/rust/...). */
  async function handle({ req, route, payload, send, actorId, isStaff }) {
    try {
      const path = route.join('/');
      if (req.method === 'GET' && path === 'status') {
        return send(200, { mode: config.mode, servers: Object.keys(config.servers), requireVerification: config.requireVerification, counts: config.mode === 'off' ? {} : (await list({ limit: 1 })).counts });
      }
      if (req.method !== 'POST') return send(404, { error: 'Not found.', code: 'not_found' });
      if (path === 'orders') return send(200, await enqueue(payload));
      if (path === 'refunds') return send(200, await refund(payload?.orderRef));
      // The signed actor is the signed-in customer; the website never chooses another one.
      if (path === 'verify/start') return send(200, await startVerification(actorId, payload?.platform, payload?.gamertag));
      if (path === 'verify/status') { enabled(); return send(200, await verificationStatus(actorId)); }
      if (route[0] === 'deliveries') {
        enabled();
        if (!(await isStaff(actorId))) return send(403, { error: 'Only Cloudy staff can manage deliveries.', code: 'forbidden' });
        if (path === 'deliveries/query') return send(200, await list({ status: DELIVERY_STATUSES.includes(payload?.status) ? payload.status : null, limit: Number(payload?.limit) || 100 }));
        if (route.length === 3 && /^[a-f0-9]{24}$/.test(route[1])) return send(200, { delivery: await staffAction(route[1], route[2], actorId) });
      }
      return send(404, { error: 'Not found.', code: 'not_found' });
    } catch (error) {
      if (error instanceof FulfillmentError) return send(error.status, { error: error.message, code: error.code });
      log.error('[RUST] Request failed:', error);
      return send(500, { error: 'Kit delivery could not complete this request.', code: 'fulfillment_error' });
    }
  }

  function start() {
    if (config.mode === 'off' || timer) return;
    void recoverInterrupted().catch(error => log.warn('[RUST] Could not check interrupted deliveries:', error?.message));
    timer = setInterval(() => { void processDue(); }, config.intervalMs);
    timer.unref?.();
    log.info(`[RUST] Kit delivery is ${config.mode} for ${Object.keys(config.servers).length} server(s)`);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const name of [...connections.keys()]) dropConnection(name);
  }

  return { config, enqueue, refund, processDue, recoverInterrupted, startVerification, handleChatFrame, verificationStatus, list, staffAction, handle, start, stop };
}
