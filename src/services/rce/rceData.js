// Stored data of the Rust Console Edition module, per Discord server:
// player links, player statistics, lists (ZORP list, kit lists, VIP), emote
// cooldowns, bounties, ZORP zones and store deliveries. Every write goes
// through a per-key lock; player statistics are kept in memory and written in
// batches, because a busy server logs many kills per minute.
import { Mutex } from '../../utils/mutex.js';
import { logger } from '../../utils/logger.js';

const SNOWFLAKE = /^\d{17,20}$/;
export const playerKey = name => String(name ?? '').trim().toLowerCase();

const keys = Object.freeze({
  links: guildId => `guild:${guildId}:rce:links`,
  stats: (guildId, serverId) => `guild:${guildId}:rce:stats:${serverId}`,
  lists: guildId => `guild:${guildId}:rce:lists`,
  cooldowns: guildId => `guild:${guildId}:rce:cooldowns`,
  bounties: guildId => `guild:${guildId}:rce:bounties`,
  zorp: (guildId, serverId) => `guild:${guildId}:rce:zorp:${serverId}`,
  deliveries: guildId => `guild:${guildId}:rce:deliveries`,
});
export const RCE_KEYS = keys;

const MAX_PLAYERS = 5_000;
const MAX_COOLDOWNS = 5_000;

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** Reads a key, lets `change` edit it and stores it again, all under one lock. */
export async function mutateData(client, key, fallback, change) {
  return Mutex.runExclusive(key, async () => {
    const current = await client.db.get(key, null);
    const value = current == null ? structuredClone(fallback) : current;
    const result = await change(value);
    if (await client.db.set(key, value) === false) throw new Error('Could not save the Rust data. Please try again.');
    return result;
  });
}

export async function readData(client, key, fallback) {
  const value = await client.db.get(key, null);
  return value == null ? structuredClone(fallback) : value;
}

// ---------------------------------------------------------------- links

function emptyLinks() {
  return { byDiscord: {} };
}

export async function getLinks(client, guildId) {
  const links = asObject(await readData(client, keys.links(guildId), emptyLinks()));
  return { byDiscord: asObject(links.byDiscord) };
}

export function linkForDiscord(links, discordId) {
  return links?.byDiscord?.[discordId] || null;
}

export function discordForPlayer(links, name) {
  const wanted = playerKey(name);
  for (const [discordId, link] of Object.entries(links?.byDiscord || {})) {
    if (playerKey(link?.gamertag) === wanted) return discordId;
  }
  return null;
}

/**
 * Links a Discord member to a gamertag in this server. One gamertag belongs to
 * one member: linking it to someone else needs `force` (staff).
 */
export async function setLink(client, guildId, discordId, gamertag, { method = 'staff', platform = null, force = false, now = Date.now() } = {}) {
  if (!SNOWFLAKE.test(String(discordId))) throw new Error('Invalid Discord member.');
  return mutateData(client, keys.links(guildId), emptyLinks(), links => {
    links.byDiscord = asObject(links.byDiscord);
    const owner = discordForPlayer(links, gamertag);
    if (owner && owner !== discordId) {
      if (!force) throw new Error('That gamertag is already linked to another member.');
      delete links.byDiscord[owner];
    }
    const previous = links.byDiscord[discordId] || null;
    links.byDiscord[discordId] = { gamertag: String(gamertag).trim(), platform: platform || previous?.platform || null, method, linkedAt: new Date(now).toISOString() };
    return { previous, replacedOwner: owner && owner !== discordId ? owner : null };
  });
}

export async function removeLink(client, guildId, discordId) {
  return mutateData(client, keys.links(guildId), emptyLinks(), links => {
    links.byDiscord = asObject(links.byDiscord);
    const previous = links.byDiscord[discordId] || null;
    delete links.byDiscord[discordId];
    return previous;
  });
}

// ---------------------------------------------------------------- lists

function emptyLists() {
  return { zorp: [], rider: [], kitLists: {}, claims: {}, vip: {} };
}

export async function getLists(client, guildId) {
  const lists = asObject(await readData(client, keys.lists(guildId), emptyLists()));
  return {
    zorp: Array.isArray(lists.zorp) ? lists.zorp : [],
    rider: Array.isArray(lists.rider) ? lists.rider : [],
    kitLists: asObject(lists.kitLists),
    claims: asObject(lists.claims),
    vip: asObject(lists.vip),
  };
}

export async function mutateLists(client, guildId, change) {
  return mutateData(client, keys.lists(guildId), emptyLists(), async lists => {
    lists.zorp = Array.isArray(lists.zorp) ? lists.zorp : [];
    lists.rider = Array.isArray(lists.rider) ? lists.rider : [];
    lists.kitLists = asObject(lists.kitLists);
    lists.claims = asObject(lists.claims);
    lists.vip = asObject(lists.vip);
    return change(lists);
  });
}

// ---------------------------------------------------------------- cooldowns

/** Reserves a cooldown; false while it is still running. */
export async function takeCooldown(client, guildId, key, cooldownMs, now = Date.now()) {
  if (!cooldownMs) return { ok: true };
  return mutateData(client, keys.cooldowns(guildId), {}, cooldowns => {
    const until = Number(cooldowns[key]) || 0;
    if (until > now) return { ok: false, remainingMs: until - now };
    cooldowns[key] = now + cooldownMs;
    const entries = Object.entries(cooldowns);
    if (entries.length > MAX_COOLDOWNS) {
      for (const [old, at] of entries) if (Number(at) <= now) delete cooldowns[old];
    }
    return { ok: true };
  });
}

export async function releaseCooldown(client, guildId, key) {
  return mutateData(client, keys.cooldowns(guildId), {}, cooldowns => { delete cooldowns[key]; });
}

// ---------------------------------------------------------------- bounties

export async function getBounties(client, guildId) {
  return asObject(await readData(client, keys.bounties(guildId), {}));
}

export async function mutateBounties(client, guildId, change) {
  return mutateData(client, keys.bounties(guildId), {}, change);
}

// ---------------------------------------------------------------- stats

function emptyStats(now) {
  return { since: now, players: {} };
}

export function emptyPlayerStats(name, now) {
  return { name, kills: 0, deaths: 0, npcKills: 0, deathsByPlayer: 0, suicides: 0, streak: 0, bestStreak: 0, playtimeMs: 0, firstSeen: now, lastSeen: now, platform: null };
}

/**
 * Player statistics per game server, kept in memory and saved every
 * `flushMs` (and on shutdown). `mutate` changes them right away in memory.
 */
export function createStatsStore(client, { flushMs = 30_000, now = () => Date.now(), log = logger } = {}) {
  const loaded = new Map();
  const loading = new Map();
  const dirty = new Set();
  let timer = null;

  async function load(guildId, serverId) {
    const key = keys.stats(guildId, serverId);
    if (loaded.has(key)) return loaded.get(key);
    if (!loading.has(key)) {
      loading.set(key, (async () => {
        const raw = asObject(await client.db.get(key, null));
        const value = { since: Number(raw.since) || now(), players: asObject(raw.players) };
        loaded.set(key, value);
        return value;
      })().finally(() => loading.delete(key)));
    }
    return loading.get(key);
  }

  async function mutate(guildId, serverId, change) {
    const state = await load(guildId, serverId);
    const result = change(state, name => {
      const lower = playerKey(name);
      if (!lower) return null;
      if (!state.players[lower]) {
        if (Object.keys(state.players).length >= MAX_PLAYERS) return null;
        state.players[lower] = emptyPlayerStats(String(name).trim(), now());
      }
      const entry = state.players[lower];
      entry.name = String(name).trim() || entry.name;
      return entry;
    });
    dirty.add(keys.stats(guildId, serverId));
    schedule();
    return result;
  }

  async function reset(guildId, serverId) {
    const key = keys.stats(guildId, serverId);
    loaded.set(key, emptyStats(now()));
    dirty.add(key);
    await flush();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, flushMs);
    timer.unref?.();
  }

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const key of [...dirty]) {
      dirty.delete(key);
      try {
        if (await client.db.set(key, loaded.get(key)) === false) dirty.add(key);
      } catch (error) {
        dirty.add(key);
        log.warn('[RCE] Could not save player statistics:', error?.message);
      }
    }
    if (dirty.size) schedule();
  }

  function forget(guildId, serverId) {
    const key = keys.stats(guildId, serverId);
    loaded.delete(key);
    dirty.delete(key);
  }

  return { load, mutate, reset, flush, forget };
}

/** Ranked players. `by`: kills, kd, playtime, streak, npc. */
export function rankPlayers(state, by = 'kills', limit = 10) {
  const players = Object.values(asObject(state?.players));
  const kd = player => (player.deaths ? player.kills / player.deaths : player.kills);
  const score = {
    kills: player => player.kills,
    kd: player => (player.kills + player.deaths >= 5 ? kd(player) : -1),
    playtime: player => player.playtimeMs,
    streak: player => player.bestStreak,
    npc: player => player.npcKills,
  }[by] || (player => player.kills);
  return players
    .filter(player => score(player) > 0)
    .sort((a, b) => score(b) - score(a) || b.kills - a.kills || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map(player => ({ ...player, kd: kd(player) }));
}

// ---------------------------------------------------------------- zorp

export async function getZones(client, guildId, serverId) {
  const raw = asObject(await readData(client, keys.zorp(guildId, serverId), { zones: {} }));
  return { zones: asObject(raw.zones) };
}

export async function mutateZones(client, guildId, serverId, change) {
  return mutateData(client, keys.zorp(guildId, serverId), { zones: {} }, async state => {
    state.zones = asObject(state.zones);
    return change(state);
  });
}

// ---------------------------------------------------------------- deliveries

export function emptyDeliveries() {
  return { pending: [], done: [], processed: [] };
}

export async function getDeliveries(client, guildId) {
  const raw = asObject(await readData(client, keys.deliveries(guildId), emptyDeliveries()));
  return {
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    done: Array.isArray(raw.done) ? raw.done : [],
    processed: Array.isArray(raw.processed) ? raw.processed : [],
  };
}

export async function mutateDeliveries(client, guildId, change) {
  return mutateData(client, keys.deliveries(guildId), emptyDeliveries(), async state => {
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    state.done = Array.isArray(state.done) ? state.done.slice(-200) : [];
    state.processed = Array.isArray(state.processed) ? state.processed.slice(-2000) : [];
    return change(state);
  });
}
