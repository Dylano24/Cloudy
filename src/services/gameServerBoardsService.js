// Live boards for the game servers (owner's choice), fed by the same link
// point as the feeds: #server-status (status of every server), #population
// (sent by a webhook named "Cloudy Population", players per server) and
// #leaderboard (kills and deaths from the kill feed, reset on a wipe).
// Each board is ONE message, edited in place; nothing is posted before the
// first event arrives.
import { readFile } from 'node:fs/promises';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { findCloudyChannelByAlias, getCloudyChannelDefinition } from './cloudyChannelResolver.js';

const LOGO = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const POPULATION_WEBHOOK_NAME = 'Cloudy Population';
export const OFFLINE_AFTER_MS = 5 * 60_000;
export const BOARD_EDIT_INTERVAL_MS = 30_000;
export const LEADERBOARD_SIZE = 10;
export const BOARD_CHANNELS = Object.freeze({
  status: { key: 'serverStatus', name: '#server-status' },
  population: { key: 'population', name: '#population' },
  leaderboard: { key: 'leaderboard', name: '#leaderboard' },
});
const MAX_SERVERS = 20;
const MAX_PLAYERS_PER_SERVER = 2_000;

const stateKey = guildId => `guild:${guildId}:gameserver:boards:v1`;
const unix = ms => Math.floor(ms / 1000);
const board = (title, description) => ({
  title, description: description.slice(0, 4096), color: 0xFFFFFF, thumbnail: { url: LOGO }, footer: { text: FOOTER },
});

function emptyState() {
  return { servers: {}, leaderboard: {}, messages: {} };
}

async function readState(client, guildId) {
  const raw = unwrapReplitData(await client.db.get(stateKey(guildId), null));
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyState();
  return { servers: state.servers || {}, leaderboard: state.leaderboard || {}, messages: state.messages || {} };
}

async function updateState(client, guildId, change) {
  return Mutex.runExclusive(stateKey(guildId), async () => {
    const state = await readState(client, guildId);
    const result = change(state);
    if (await client.db.set(stateKey(guildId), state) === false) throw new Error('Could not save the game server boards');
    return result;
  });
}

const isOnline = (server, now) => server.online === true && now - (server.updatedAt || 0) < OFFLINE_AFTER_MS;
const sortedServers = state => Object.entries(state.servers).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));

export function buildStatusBoard(state, now = Date.now()) {
  const servers = sortedServers(state);
  const blocks = servers.map(([name, server]) => {
    const online = isOnline(server, now);
    const details = online
      ? [`Online · ${server.players ?? 0}${server.max ? `/${server.max}` : ''} players${server.queue ? ` · Queue ${server.queue}` : ''}`,
        [server.map ? `Map: ${server.map}` : null, server.nextWipe ? `Next wipe <t:${unix(server.nextWipe)}:R>` : null].filter(Boolean).join(' · ')]
      : ['Offline'];
    return [`${online ? '🟢' : '🔴'} **${name}**`, ...details.filter(Boolean)].join('\n');
  });
  const updated = Math.max(0, ...servers.map(([, server]) => server.updatedAt || 0));
  return board('Server status', [
    blocks.length ? blocks.join('\n\n') : 'No servers yet.',
    ...(updated ? ['', `**Last update:** <t:${unix(updated)}:R>`] : []),
  ].join('\n'));
}

function populationBar(players, max) {
  const filled = max ? Math.max(0, Math.min(10, Math.round((players / max) * 10))) : 0;
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function buildPopulationBoard(state, now = Date.now()) {
  const servers = sortedServers(state);
  let total = 0;
  const blocks = servers.map(([name, server]) => {
    if (!isOnline(server, now)) return `**${name}**\nOffline`;
    const players = server.players ?? 0;
    total += players;
    return `**${name}**\n\`${populationBar(players, server.max)}\` ${players}${server.max ? `/${server.max}` : ''}${server.queue ? ` · Queue ${server.queue}` : ''}`;
  });
  return board('Population', [
    blocks.length ? blocks.join('\n\n') : 'No servers yet.',
    '',
    `**Total online:** ${total}`,
  ].join('\n'));
}

export function buildLeaderboard(state) {
  const servers = Object.entries(state.leaderboard).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const blocks = servers.map(([name, entry]) => {
    const top = Object.entries(entry.players || {})
      .sort(([, a], [, b]) => (b.kills - a.kills) || (a.deaths - b.deaths))
      .slice(0, LEADERBOARD_SIZE)
      .map(([player, stats], index) => {
        const ratio = stats.deaths ? (stats.kills / stats.deaths).toFixed(2) : String(stats.kills);
        return `**${index + 1}.** ${player} · ${stats.kills} ${stats.kills === 1 ? 'kill' : 'kills'} · ${stats.deaths} ${stats.deaths === 1 ? 'death' : 'deaths'} · K/D ${ratio}`;
      });
    return [`**${name}**`, ...(top.length ? top : ['No kills yet.']),
      ...(entry.since ? [`Since the wipe <t:${unix(entry.since)}:R>`] : [])].join('\n');
  });
  return board('Leaderboard', blocks.length ? blocks.join('\n\n') : 'No kills yet.');
}

// ---------------------------------------------------------------- state

function serverEntry(container, name) {
  if (!container[name] && Object.keys(container).length >= MAX_SERVERS) return null;
  container[name] ||= {};
  return container[name];
}

export async function recordServerStatus(client, guild, event) {
  await updateState(client, guild.id, state => {
    const server = serverEntry(state.servers, event.server);
    if (!server) return;
    Object.assign(server, {
      online: event.online, players: event.players, max: event.max, queue: event.queue,
      map: event.map, nextWipe: event.nextWipe, updatedAt: Date.now(),
    });
  });
  scheduleBoard(client, guild, 'status');
  scheduleBoard(client, guild, 'population');
}

export async function recordKill(client, guild, event) {
  await updateState(client, guild.id, state => {
    const entry = serverEntry(state.leaderboard, event.server);
    if (!entry) return;
    entry.players ||= {};
    entry.since ||= Date.now();
    for (const [name, field] of [[event.killer, 'kills'], [event.victim, 'deaths']]) {
      if (!entry.players[name] && Object.keys(entry.players).length >= MAX_PLAYERS_PER_SERVER) continue;
      entry.players[name] ||= { kills: 0, deaths: 0 };
      entry.players[name][field] += 1;
    }
  });
  scheduleBoard(client, guild, 'leaderboard');
}

// A finished wipe starts that server's leaderboard again.
export async function resetLeaderboard(client, guild, server) {
  await updateState(client, guild.id, state => {
    if (state.leaderboard[server]) state.leaderboard[server] = { players: {}, since: Date.now() };
  });
  scheduleBoard(client, guild, 'leaderboard');
}

// ---------------------------------------------------------------- Discord

const populationHooks = new Map();
let logoFile = null;

async function populationWebhook(client, channel) {
  const cached = populationHooks.get(channel.id);
  if (cached) return cached;
  const hooks = await channel.fetchWebhooks();
  let hook = [...hooks.values()].find(item => item.name === POPULATION_WEBHOOK_NAME
    && item.owner?.id === client.user?.id && item.token);
  if (!hook) {
    // Webhooks cannot have an animated avatar: use the still Cloudy logo.
    logoFile ||= readFile(new URL('../../assets/cloudy-c-logo.png', import.meta.url)).catch(() => null);
    const avatar = await logoFile;
    hook = await channel.createWebhook({
      name: POPULATION_WEBHOOK_NAME, ...(avatar ? { avatar } : {}), reason: 'Cloudy population board',
    });
  }
  populationHooks.set(channel.id, hook);
  return hook;
}

const BUILDERS = { status: buildStatusBoard, population: buildPopulationBoard, leaderboard: buildLeaderboard };

async function renderBoard(client, guild, name) {
  const definition = getCloudyChannelDefinition(BOARD_CHANNELS[name].key);
  const channel = findCloudyChannelByAlias(guild, definition?.aliases || [], { textOnly: true });
  if (!channel?.send) return;
  const state = await readState(client, guild.id);
  const payload = { embeds: [BUILDERS[name](state)], allowedMentions: { parse: [] } };
  const messageId = state.messages[name];
  const hook = name === 'population' ? await populationWebhook(client, channel) : null;
  if (messageId) {
    try {
      if (hook) await hook.editMessage(messageId, payload);
      else await (await channel.messages.fetch(messageId)).edit(payload);
      return;
    } catch (error) {
      // 10008: the board was removed; post it again below.
      if (error?.code !== 10008) throw error;
    }
  }
  const sent = hook ? await hook.send(payload) : await channel.send(payload);
  await updateState(client, guild.id, next => { next.messages[name] = sent.id; });
}

// At most one edit per board every 30 seconds.
const pending = new Map();
const lastRender = new Map();

export function scheduleBoard(client, guild, name) {
  const key = `${guild.id}:${name}`;
  if (pending.has(key)) return;
  const wait = Math.max(0, (lastRender.get(key) || 0) + BOARD_EDIT_INTERVAL_MS - Date.now());
  const timer = setTimeout(() => {
    pending.delete(key);
    lastRender.set(key, Date.now());
    void renderBoard(client, guild, name)
      .catch(error => logger.warn(`Game server ${name} board update failed: ${error?.message || error}`));
  }, Math.max(wait, 1_000));
  timer.unref?.();
  pending.set(key, timer);
}

// Every minute: a server that stopped reporting shows as offline.
let started = false;
export function startGameServerBoards(client) {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    for (const guild of client.guilds?.cache?.values?.() || []) {
      void readState(client, guild.id).then(state => {
        if (!Object.keys(state.servers).length) return;
        scheduleBoard(client, guild, 'status');
        scheduleBoard(client, guild, 'population');
      }).catch(() => {});
    }
  }, 60_000);
  timer.unref?.();
}

// Test helper.
export function resetGameServerBoards() {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  lastRender.clear();
  populationHooks.clear();
}
