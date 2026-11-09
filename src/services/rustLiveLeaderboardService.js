import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { unwrapReplitData } from '../utils/database.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from './gameFeedService.js';
import { logger } from '../utils/logger.js';

const CONFIG_KEY = guildId => 'guild:' + guildId + ':rust-liveboard:v1';
const BOARD_KEY = guildId => 'guild:' + guildId + ':gameserver:boards:v1';
const MAX_RANK = 10;
const MAX_STALE_MS = 5 * 60_000;
const THROTTLE_MS = 15_000;
const pending = new Map();
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
const localDate = now => DATE_FORMAT.format(new Date(now));

function cleanName(value, max = 45) {
  return String(value ?? '').replace(/[\r\n\x60*_~<>@|[\]]/g, '').trim().slice(0, max) || 'Unknown';
}
function stat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}
export function getLiveRankings(state, filter = null) {
  const all = state?.leaderboard && typeof state.leaderboard === 'object' ? state.leaderboard : {};
  const servers = Object.entries(all)
    .filter(([name]) => !filter || name.toLowerCase() === filter.toLowerCase())
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  return servers.map(([server, board]) => {
    const players = Object.entries(board.players || {}).map(([name, raw]) => {
      const kills = stat(raw.kills);
      const deaths = stat(raw.deaths);
      return { name: cleanName(name, 26), kills, deaths, kd: deaths ? kills / deaths : kills };
    }).sort((a, b) => b.kills - a.kills || b.kd - a.kd || a.deaths - b.deaths || a.name.localeCompare(b.name));
    return { server, since: board.since, players: players.slice(0, MAX_RANK), count: players.length };
  });
}

function boardLines(players) {
  if (!players.length) return 'No verified kill events yet.';
  return players.map((player, index) => {
    const rank = String(index + 1).padStart(2, '0');
    const kd = player.kd.toFixed(2);
    return '**' + rank + '.** ' + player.name + '\n'
      + 'Kills **' + player.kills + '**  ·  Deaths **' + player.deaths + '**  ·  K/D **' + kd + '**';
  }).join('\n\n');
}

function asUnix(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value / 1000);
}

export function buildRustLiveBoard(state, filter = null, now = Date.now()) {
  const servers = getLiveRankings(state, filter);
  const selected = servers[0] || null;
  const allStatuses = state?.servers || {};
  const status = selected ? allStatuses[selected.server] : filter ? allStatuses[filter] : Object.values(allStatuses)[0];
  const serverName = cleanName(selected?.server || filter || Object.keys(allStatuses)[0] || 'Rust Console');
  const lastAt = stat(status?.updatedAt);
  const liveStatus = status?.online === true && lastAt > 0 && now - lastAt <= MAX_STALE_MS;
  const statusText = status == null || lastAt === 0 ? 'Not connected'
    : liveStatus ? 'Online' : 'Offline / data delayed';
  const playerCount = liveStatus && Number.isFinite(status?.players) ? String(status.players)
    + (Number.isFinite(status.max) ? '/' + status.max : '') : '—';
  const storedDaily = state?.daily?.[selected?.server || filter] || null;
  const daily = storedDaily?.date === localDate(now) ? storedDaily : null;
  const dailyTop = Object.entries(daily?.kills || {}).sort(([, a], [, b]) => b - a)[0];
  const since = asUnix(selected?.since);
  const lastUpdate = asUnix(lastAt);
  const nextWipe = asUnix(status?.nextWipe);

  return {
    title: 'Rust leaderboard',
    color: 0xFFFFFF,
    description: '**' + serverName + '**\n\n'
      + (selected?.players.length ? '**Top 10 — current wipe**\n\n' + boardLines(selected.players)
        : '**Top 10 — current wipe**\n\nNo verified kill events yet.'),
    fields: [
      { name: 'Server', value: '**Status:** ' + statusText
        + '\n**Players:** ' + playerCount
        + '\n**Map:** ' + cleanName(status?.map || 'Unavailable', 40), inline: true },
      { name: 'Wipe', value: '**Started:** ' + (since ? '<t:' + since + ':d>' : 'Not confirmed')
        + '\n**Next:** ' + (nextWipe ? '<t:' + nextWipe + ':R>' : 'Not scheduled')
        + '\n**Tracked players:** ' + (selected?.count || 0), inline: true },
      { name: 'Daily top killer', value: dailyTop
        ? '**' + cleanName(dailyTop[0], 30) + '** · ' + stat(dailyTop[1]) + ' kills'
        : 'No verified kills today.', inline: false },
      { name: 'Data', value: lastUpdate ? 'Last server update <t:' + lastUpdate + ':R>'
        : 'Waiting for a Rust game-server connection.', inline: false },
    ],
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
}

export async function getRustLiveBoardConfig(client, guildId) {
  const config = unwrapReplitData(await client.db.get(CONFIG_KEY(guildId)));
  return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

async function saveConfig(client, guildId, config) {
  if (await client.db.set(CONFIG_KEY(guildId), config) === false) throw new Error('Could not save the leaderboard settings.');
}

function canPost(channel, client) {
  return channel?.type === ChannelType.GuildText && channel.permissionsFor(client.user)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
  ]);
}

async function readSourceBoard(client, sourceGuildId) {
  return unwrapReplitData(await client.db.get(BOARD_KEY(sourceGuildId))) || {};
}

async function renderRustLiveBoard(client, guild, config) {
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!canPost(channel, client)) throw new Error('Cloudy needs permission to post in the leaderboard channel.');
  const state = await readSourceBoard(client, config.sourceGuildId);
  const payload = { embeds: [buildRustLiveBoard(state, config.server)], allowedMentions: { parse: [] } };
  if (config.messageId) {
    const existing = await channel.messages.fetch(config.messageId).catch(() => null);
    if (existing && existing.author?.id === client.user?.id) {
      await existing.edit(payload);
      return existing;
    }
  }
  const sent = await channel.send(payload);
  await saveConfig(client, guild.id, { ...config, messageId: sent.id });
  return sent;
}

export async function startRustLiveBoard(client, guild, channel, sourceGuildId, server = null) {
  if (!/^\d{17,20}$/.test(String(sourceGuildId))) throw new Error('Invalid source server.');
  if (!canPost(channel, client)) throw new Error('Cloudy cannot post in this channel.');
  const previous = await getRustLiveBoardConfig(client, guild.id);
  const updated = {
    enabled: true, sourceGuildId, channelId: channel.id,
    server: server ? String(server).trim().slice(0, 60) : null,
    messageId: previous?.channelId === channel.id ? previous.messageId : null,
  };
  const posted = await renderRustLiveBoard(client, guild, updated);
  const saved = { ...updated, messageId: posted.id };
  await saveConfig(client, guild.id, saved);
  // An old board remains intact; it does not keep updating when disabled.
  return { config: saved, message: posted };
}

export async function stopRustLiveBoard(client, guildId) {
  const existing = await getRustLiveBoardConfig(client, guildId);
  if (!existing) return false;
  await saveConfig(client, guildId, { ...existing, enabled: false });
  return true;
}

export async function refreshRustLiveBoardMirrors(client, sourceGuildId) {
  if (!client?.guilds?.cache) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getRustLiveBoardConfig(client, guild.id);
      if (!config?.enabled || config.sourceGuildId !== sourceGuildId) continue;
      const key = guild.id + ':' + config.channelId;
      if (pending.has(key)) continue;
      const timer = setTimeout(() => {
        pending.delete(key);
        void renderRustLiveBoard(client, guild, config)
          .catch(error => logger.warn('[RUST_LIVEBOARD] Update failed:', error));
      }, THROTTLE_MS);
      timer.unref?.();
      pending.set(key, timer);
    } catch (error) {
      logger.warn('[RUST_LIVEBOARD] Cannot read mirror configuration:', error);
    }
  }
}

export function resetRustLiveBoardTimers() {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
