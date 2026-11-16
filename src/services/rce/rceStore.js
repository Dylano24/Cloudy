// Per-server (Discord guild) settings of the Rust Console Edition module.
//
// guild:<id>:rce:v1 holds the game servers, the feed channels, the settings,
// the Discord shop, the emote actions, teleport locations, automatic in-game
// messages and the ZORP settings. Big or fast-changing data (player stats,
// links, zones, deliveries) lives in its own keys (rceData.js).
// RCON passwords are stored encrypted (AES-256-GCM).
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Mutex } from '../../utils/mutex.js';
import { logger } from '../../utils/logger.js';
import { billingPremiumEnd } from '../../web/billingEntitlements.js';
import { QUICK_CHAT } from './rceParser.js';

export const RCE_LIMITS = Object.freeze({
  servers: 10, shop: 25, emotes: 25, locations: 25, automessages: 15, nameLength: 40,
});

export const FEED_TYPES = Object.freeze({
  killfeed: 'Kill feed',
  joins: 'Joins and leaves',
  chat: 'In-game chat',
  events: 'World events',
  admin: 'Admin log',
  zorp: 'ZORP',
  shop: 'Shop and deliveries',
  status: 'Server status',
});

export const SHOP_TYPES = Object.freeze({ item: 'Item', kit: 'Kit', vip: 'VIP', command: 'Command' });
export const EMOTE_ACTIONS = Object.freeze({ kit: 'Kit', item: 'Item', teleport: 'Teleport', command: 'Command' });

// Home servers of Cloudy itself never need Premium for the Rust module.
const HOME_GUILD_IDS = ['1532882647838228723'];

const configKey = guildId => `guild:${guildId}:rce:v1`;
const INDEX_KEY = 'rce:guild-index';
const planKey = guildId => `guild:${guildId}:dashboard:plan`;
const CACHE_MS = 15_000;
const cache = new Map();
const listeners = new Set();

const SNOWFLAKE = /^\d{17,20}$/;
const id = value => (SNOWFLAKE.test(String(value ?? '')) ? String(value) : null);
const str = (value, max = 100) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const int = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
};
const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback);
const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

export const DEFAULT_SETTINGS = Object.freeze({
  killfeedMode: 'pvp', // pvp | all
  ingameKillfeed: false,
  ingameJoins: false,
  ingameEvents: false,
  welcomeMessage: '',
  linkedRoleId: null,
  announceClaims: true,
  rewards: Object.freeze({ kill: 0, npcKill: 0, playtimeHour: 0 }),
  bounties: true,
  bountyMin: 100,
});

export const DEFAULT_ZORP = Object.freeze({
  enabled: false,
  radius: 30,
  yellowMinutes: 10,
  expiryHours: 24,
  requireList: false,
});

function normalizeServer(raw) {
  const serverId = str(raw?.id, 16).toLowerCase();
  if (!/^[a-z0-9-]{1,16}$/.test(serverId)) return null;
  const port = int(raw?.port, 1, 65535, null);
  const host = str(raw?.host, 253);
  if (!port || !/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null;
  return {
    id: serverId,
    name: str(raw?.name, RCE_LIMITS.nameLength) || serverId,
    host,
    port,
    tls: raw?.tls === true,
    password: raw?.password && typeof raw.password === 'object' ? raw.password : null,
    enabled: raw?.enabled !== false,
    addedBy: id(raw?.addedBy),
    addedAt: str(raw?.addedAt, 40) || null,
  };
}

function normalizeShopItem(raw) {
  if (!raw || !Object.hasOwn(SHOP_TYPES, raw.type)) return null;
  return {
    id: str(raw.id, 40) || randomUUID().slice(0, 8),
    name: str(raw.name, 40),
    type: raw.type,
    value: str(raw.value, 300),
    amount: int(raw.amount, 1, 1_000_000, 1),
    price: int(raw.price, 0, 1_000_000_000, 0),
    cooldownMinutes: int(raw.cooldownMinutes, 0, 525_600, 0),
    vipDays: int(raw.vipDays, 0, 365, 0),
    server: str(raw.server, 16) || 'all',
    description: str(raw.description, 100),
  };
}

function normalizeEmote(raw) {
  if (!raw || !Object.hasOwn(EMOTE_ACTIONS, raw.action) || !Object.hasOwn(QUICK_CHAT, raw.trigger)) return null;
  return {
    id: str(raw.id, 40) || randomUUID().slice(0, 8),
    trigger: raw.trigger,
    action: raw.action,
    value: str(raw.value, 300),
    amount: int(raw.amount, 1, 1_000_000, 1),
    cooldownMinutes: int(raw.cooldownMinutes, 0, 525_600, 60),
    price: int(raw.price, 0, 1_000_000_000, 0),
    linkedOnly: bool(raw.linkedOnly, true),
    kitList: bool(raw.kitList, false),
    oncePerWipe: bool(raw.oncePerWipe, false),
    server: str(raw.server, 16) || 'all',
    name: str(raw.name, 40),
  };
}

function normalizeLocation(raw) {
  const name = str(raw?.name, 32);
  const [x, y, z] = [raw?.x, raw?.y, raw?.z].map(Number);
  if (!name || ![x, y, z].every(value => Number.isFinite(value) && Math.abs(value) <= 10_000)) return null;
  return { name, x, y, z, server: str(raw?.server, 16) || 'all' };
}

function normalizeAutomessage(raw) {
  const text = str(raw?.text, 200);
  if (!text) return null;
  return { id: str(raw?.id, 40) || randomUUID().slice(0, 8), text, intervalMinutes: int(raw?.intervalMinutes, 5, 1440, 30), server: str(raw?.server, 16) || 'all' };
}

export function normalizeRceConfig(raw) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const settings = item.settings && typeof item.settings === 'object' ? item.settings : {};
  const rewards = settings.rewards && typeof settings.rewards === 'object' ? settings.rewards : {};
  const zorp = item.zorp && typeof item.zorp === 'object' ? item.zorp : {};
  const channels = {};
  for (const type of Object.keys(FEED_TYPES)) {
    const channelId = id(item.channels?.[type]);
    if (channelId) channels[type] = channelId;
  }
  const seen = new Set();
  const servers = list(item.servers, RCE_LIMITS.servers).map(normalizeServer)
    .filter(server => server && !seen.has(server.id) && seen.add(server.id));
  return {
    version: 1,
    servers,
    channels,
    settings: {
      killfeedMode: settings.killfeedMode === 'all' ? 'all' : 'pvp',
      ingameKillfeed: bool(settings.ingameKillfeed),
      ingameJoins: bool(settings.ingameJoins),
      ingameEvents: bool(settings.ingameEvents),
      welcomeMessage: str(settings.welcomeMessage, 160),
      linkedRoleId: id(settings.linkedRoleId),
      announceClaims: bool(settings.announceClaims, true),
      rewards: {
        kill: int(rewards.kill, 0, 1_000_000, 0),
        npcKill: int(rewards.npcKill, 0, 1_000_000, 0),
        playtimeHour: int(rewards.playtimeHour, 0, 1_000_000, 0),
      },
      bounties: bool(settings.bounties, true),
      bountyMin: int(settings.bountyMin, 1, 1_000_000_000, 100),
    },
    shop: list(item.shop, RCE_LIMITS.shop).map(normalizeShopItem).filter(Boolean),
    emotes: list(item.emotes, RCE_LIMITS.emotes).map(normalizeEmote).filter(Boolean),
    locations: list(item.locations, RCE_LIMITS.locations).map(normalizeLocation).filter(Boolean),
    automessages: list(item.automessages, RCE_LIMITS.automessages).map(normalizeAutomessage).filter(Boolean),
    zorp: {
      enabled: bool(zorp.enabled),
      radius: int(zorp.radius, 10, 150, DEFAULT_ZORP.radius),
      yellowMinutes: int(zorp.yellowMinutes, 1, 240, DEFAULT_ZORP.yellowMinutes),
      expiryHours: int(zorp.expiryHours, 1, 168, DEFAULT_ZORP.expiryHours),
      requireList: bool(zorp.requireList),
    },
    delivery: {
      channelId: id(item.delivery?.channelId),
    },
  };
}

// ---------------------------------------------------------------- secrets

let warnedFallback = false;
function encryptionKey(env = process.env) {
  const configured = String(env.RCE_ENCRYPTION_KEY || env.CLOUDY_RCE_ENCRYPTION_KEY || '').trim();
  if (configured.length >= 16) return { key: createHash('sha256').update(`cloudy-rce:${configured}`).digest(), source: 'env' };
  const token = String(env.DISCORD_TOKEN || env.TOKEN || env.BOT_TOKEN || env.DISCORD_BOT_TOKEN || '').trim();
  if (!token) return null;
  if (!warnedFallback) {
    warnedFallback = true;
    logger.warn('[RCE] RCE_ENCRYPTION_KEY is not set: RCON passwords are encrypted with a key derived from the bot token. Set RCE_ENCRYPTION_KEY so a new token does not require entering the passwords again.');
  }
  return { key: createHash('sha256').update(`cloudy-rce-token:${token}`).digest(), source: 'token' };
}

export function sealSecret(plain, env = process.env) {
  const text = String(plain ?? '');
  if (!text || text.length > 200) throw new Error('Invalid RCON password.');
  const key = encryptionKey(env);
  if (!key) throw new Error('No encryption key is available for the RCON password.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { v: 1, k: key.source, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** The password, or null when it cannot be read (for example after a key change). */
export function openSecret(sealed, env = process.env) {
  if (!sealed || sealed.v !== 1) return null;
  const key = encryptionKey(env);
  if (!key) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- config

export async function getRceConfig(client, guildId, { fresh = false } = {}) {
  const entry = cache.get(guildId);
  if (!fresh && entry && entry.until > Date.now()) return entry.value;
  const value = normalizeRceConfig(await client.db.get(configKey(guildId), null));
  cache.set(guildId, { value, until: Date.now() + CACHE_MS });
  return value;
}

/** Changes the settings under a lock; `change` edits a copy and may return a result. */
export async function updateRceConfig(client, guildId, change) {
  const result = await Mutex.runExclusive(configKey(guildId), async () => {
    const config = normalizeRceConfig(await client.db.get(configKey(guildId), null));
    const outcome = await change(config);
    const next = normalizeRceConfig(config);
    if (await client.db.set(configKey(guildId), next) === false) throw new Error('The Rust settings could not be saved. Please try again.');
    cache.set(guildId, { value: next, until: Date.now() + CACHE_MS });
    await updateIndex(client, guildId, next.servers.length > 0);
    return { config: next, outcome };
  });
  for (const listener of listeners) {
    try { listener(guildId, result.config); } catch (error) { logger.warn('[RCE] Config listener failed:', error?.message); }
  }
  return result;
}

export function onRceConfigChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function updateIndex(client, guildId, present) {
  await Mutex.runExclusive(INDEX_KEY, async () => {
    const current = await client.db.get(INDEX_KEY, []);
    const ids = new Set(Array.isArray(current) ? current.filter(value => SNOWFLAKE.test(String(value))) : []);
    if (present === ids.has(guildId)) return;
    if (present) ids.add(guildId); else ids.delete(guildId);
    await client.db.set(INDEX_KEY, [...ids]);
  });
}

export async function rceGuildIds(client) {
  const current = await client.db.get(INDEX_KEY, []);
  return Array.isArray(current) ? current.filter(value => SNOWFLAKE.test(String(value))) : [];
}

export function clearRceConfigCache() {
  cache.clear();
}

export function findServer(config, query) {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return config.servers.length === 1 ? config.servers[0] : null;
  return config.servers.find(server => server.id === text) || config.servers.find(server => server.name.toLowerCase() === text) || null;
}

/** Ids of the servers an entry with `server` ("all" or one id) applies to. */
export function appliesTo(entry, serverId) {
  return !entry?.server || entry.server === 'all' || entry.server === serverId;
}

export function slugify(name, taken = []) {
  const base = String(name || 'server').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
    .slice(0, 13).replace(/-+$/, '') || 'server';
  let candidate = base;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

// ---------------------------------------------------------------- plan

export function isHomeGuild(guildId, env = process.env) {
  const ids = new Set([...HOME_GUILD_IDS, String(env.GUILD_ID || '').trim(),
    ...String(env.RCE_FREE_GUILD_IDS || '').split(',').map(value => value.trim())].filter(Boolean));
  return ids.has(String(guildId));
}

/**
 * Whether this server may connect game servers: Cloudy's home servers always,
 * every other server with Cloudy Bot Premium (owner grant or Cloudy Store).
 */
export async function rcePlanAllows(client, guildId, nowMs = Date.now(), env = process.env) {
  if (isHomeGuild(guildId, env)) return true;
  if (String(env.RCE_REQUIRE_PREMIUM || 'true').trim() === 'false') return true;
  const record = await client.db.get(planKey(guildId), null);
  const until = Math.max(Date.parse(record?.premiumUntil || '') || 0, billingPremiumEnd(record, nowMs), Date.parse(record?.trialEndsAt || '') || 0);
  return until > nowMs;
}

export const RCE_PLAN_REQUIRED = 'The Rust Console module needs Cloudy Bot Premium for this server. Open the Cloudy dashboard to upgrade.';
