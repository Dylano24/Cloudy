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
const lastSentPayloads = new Map();
const localDate = now => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });

function cleanName(value, max = 45) {
  return String(value ?? '').replace(/[\r\n\x60*_~<>@|[\]]/g, '').trim().slice(0, max) || 'Unknown';
}
function stat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}
function unix(ms) {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
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

export function liveRustStatus(status, now = Date.now()) {
  const lastAt = stat(status?.updatedAt);
  if (!lastAt) return { icon: '⚪', label: 'Not connected', color: 0xFFFFFF };
  if (lastAt > now + 60_000 || now - lastAt > MAX_STALE_MS) {
    return { icon: '🟠', label: 'Delayed', color: 0xFFFFFF };
  }
  if (status.online !== true) return { icon: '🔴', label: 'Offline', color: 0x7A1712 };
  return { icon: '🟢', label: 'Live', color: 0x00C49D };
}

export function leaderboardLines(players) {
  if (!players.length) return 'No recorded kills yet.';
  return players.map((player, index) => {
    const rank = index < 3 ? ['🥇', '🥈', '🥉'][index] : '**' + (index + 1) + '.**';
    return rank + ' **' + cleanName(player.name, 26) + '**\n'
      + player.kills + ' kills  ·  ' + player.deaths + ' deaths  ·  ' + player.kd.toFixed(2) + ' K/D';
  }).join('\n\n');
}

export function buildRustLiveBoard(state, filter = null, now = Date.now()) {
  const rankings = getLiveRankings(state, filter);
  const selected = rankings[0] || null;
  const statuses = state?.servers || {};
  const serverName = selected?.server || filter || Object.keys(statuses)[0] || 'Rust Console';
  const status = statuses[serverName] || null;
  const info = liveRustStatus(status, now);
  const connected = info.label === 'Live';
  const players = connected && Number.isFinite(status.players) ? String(stat(status.players))
    + (Number.isFinite(status.max) ? '/' + stat(status.max) : '') : '—';
  const storedDaily = state?.daily?.[serverName];
  const today = storedDaily?.date === localDate(now) ? storedDaily : null;
  const topToday = Object.entries(today?.kills || {}).sort(([, a], [, b]) => Number(b) - Number(a))[0];
  const since = unix(selected?.since);
  const nextWipe = unix(status?.nextWipe);
  const lastAt = unix(status?.updatedAt);

  return {
    title: 'Rust leaderboard',
    color: info.color,
    description: '**' + cleanName(serverName, 60) + '**  ' + info.icon + ' **' + info.label + '**'
      + '\n\n**Current wipe · Top 10**\n\n' + leaderboardLines(selected?.players || []),
    fields: [
      { name: 'Server', value: '**Players:** ' + players
        + '\n**Map:** ' + cleanName(status?.map || 'Unavailable', 40)
        + '\n**Updated:** ' + (lastAt ? '<t:' + lastAt + ':R>' : 'No data'), inline: true },
      { name: 'Wipe', value: '**Tracking since:** ' + (since ? '<t:' + since + ':d>' : 'Not started')
        + '\n**Next wipe:** ' + (nextWipe ? '<t:' + nextWipe + ':R>' : 'Not scheduled')
        + '\n**Tracked players:** ' + (selected?.count || 0), inline: true },
      { name: 'Daily top killer', value: topToday
        ? '**' + cleanName(topToday[0], 30) + '** · ' + stat(topToday[1]) + ' kills'
        : 'No recorded kills today.', inline: false },
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
  if (await client.db.set(CONFIG_KEY(guildId), config) === false) {
    throw new Error('Could not save leaderboard settings.');
  }
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
  if (!canPost(channel, client)) throw new Error('Cloudy cannot post in the leaderboard channel.');
  const state = await readSourceBoard(client, config.sourceGuildId);
  const payload = { embeds: [buildRustLiveBoard(state, config.server)], allowedMentions: { parse: [] } };
  const digest = JSON.stringify(payload.embeds);
  const cacheKey = guild.id + ':' + channel.id;
  if (config.messageId) {
    const existing = await channel.messages.fetch(config.messageId).catch(() => null);
    if (existing?.author?.id === client.user?.id) {
      if (lastSentPayloads.get(cacheKey) !== digest) await existing.edit(payload);
      lastSentPayloads.set(cacheKey, digest);
      return existing;
    }
  }
  const sent = await channel.send(payload);
  await saveConfig(client, guild.id, { ...config, messageId: sent.id });
  lastSentPayloads.set(cacheKey, digest);
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
        void (async () => {
          const latest = await getRustLiveBoardConfig(client, guild.id);
          if (!latest?.enabled || latest.sourceGuildId !== sourceGuildId || latest.channelId !== config.channelId) return;
          await renderRustLiveBoard(client, guild, latest);
        })().catch(error => logger.warn('[RUST_LIVEBOARD] Update failed:', error));
      }, THROTTLE_MS);
      timer.unref?.();
      pending.set(key, timer);
    } catch (error) {
      logger.warn('[RUST_LIVEBOARD] Cannot load mirror settings:', error);
    }
  }
}

export function resetRustLiveBoardTimers() {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  lastSentPayloads.clear();
}
