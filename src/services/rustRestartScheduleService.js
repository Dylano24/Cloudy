import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { CLOUDY_C_LOGO_URL, CLOUDY_FOOTER } from './gameFeedService.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'rust-restart-notices:';
const FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function parseRustRestartTimes(input) {
  const tokens = String(input || '').split(',').map(value => value.trim());
  if (!tokens.length || tokens.length > 6 || tokens.some(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new Error('Use 1–6 times in 24-hour format: 06:00, 18:00.');
  }
  if (new Set(tokens).size !== tokens.length) throw new Error('Remove duplicate restart times.');
  return tokens.sort();
}

export function amsterdamClock(now = Date.now()) {
  const parts = Object.fromEntries(FORMAT.formatToParts(new Date(now))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + ':' + parts.minute,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function minutesAt(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function restartEventsAt(config, now = Date.now()) {
  if (!config?.enabled || !config.times?.length) return [];
  const local = amsterdamClock(now);
  const events = [];
  for (const at of config.times) {
    const until = (minutesAt(at) - local.minute + 1440) % 1440;
    if (until === config.reminderMinutes && config.reminderMinutes > 0) {
      events.push({ kind: 'reminder', at, date: local.date });
    }
    if (until === 0) events.push({ kind: 'time', at, date: local.date });
  }
  return events;
}

function restartEmbed(title, description, color = 0xFFFFFF) {
  return {
    title, description, color,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
}

export function scheduleEmbed(config) {
  return restartEmbed('Daily server restarts',
    '**Restart times**\n' + config.times.map(time => '• ' + time).join('\n')
    + '\n\n**Reminder:** ' + config.reminderMinutes + ' minutes before\n'
    + 'All times are in Amsterdam time (CET/CEST).\n'
    + 'These are notifications, not automatic game-server restarts.');
}

export async function getRustRestartConfig(client, guildId) {
  const value = await client.db.get(PREFIX + guildId);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function saveRustRestartConfig(client, guildId, config) {
  if (await client.db.set(PREFIX + guildId, config) === false) {
    throw new Error('Could not save the restart schedule.');
  }
  return config;
}

export async function publishRustRestartSchedule(client, guild, channel, input, reminderMinutes = 15) {
  const times = parseRustRestartTimes(input);
  if (!Number.isInteger(reminderMinutes) || reminderMinutes < 0 || reminderMinutes > 60) {
    throw new Error('Reminder must be 0–60 minutes.');
  }
  const old = await getRustRestartConfig(client, guild.id);
  const config = {
    enabled: true, channelId: channel.id, times, reminderMinutes,
    sent: old?.sent || {}, messageId: null,
  };
  const payload = { embeds: [scheduleEmbed(config)], allowedMentions: { parse: [] } };
  const oldChannel = old?.channelId && await guild.channels.fetch(old.channelId).catch(() => null);
  const oldMessage = old?.messageId && await oldChannel?.messages?.fetch(old.messageId).catch(() => null);
  if (oldMessage && old.channelId === channel.id) {
    await oldMessage.edit(payload);
    config.messageId = oldMessage.id;
  } else {
    const message = await channel.send(payload);
    config.messageId = message.id;
    if (oldMessage) await oldMessage.edit({
      embeds: [restartEmbed('Daily server restarts', 'This schedule has moved to <#' + channel.id + '>.')],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
  return saveRustRestartConfig(client, guild.id, config);
}

export async function disableRustRestartSchedule(client, guildId) {
  const config = await getRustRestartConfig(client, guildId);
  if (!config) return false;
  await saveRustRestartConfig(client, guildId, { ...config, enabled: false });
  return true;
}

export async function processRustRestartNotices(client, now = Date.now()) {
  if (!client?.guilds?.cache) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      let config = await getRustRestartConfig(client, guild.id);
      const events = restartEventsAt(config, now);
      if (!events.length) continue;
      const channel = await guild.channels.fetch(config.channelId).catch(() => null);
      if (channel?.type !== ChannelType.GuildText
        || !channel.permissionsFor(client.user)?.has([
          PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
        ])) continue;
      for (const event of events) {
        const label = event.kind + ':' + event.at;
        if (config.sent?.[label] === event.date) continue;
        // Persist first to avoid duplicate announcements on process restarts.
        const sent = { ...config.sent, [label]: event.date };
        config = await saveRustRestartConfig(client, guild.id, { ...config, sent });
        const reminder = event.kind === 'reminder';
        const title = reminder ? 'Restart reminder' : 'Scheduled restart time';
        const description = reminder
          ? 'A server restart is scheduled in ' + config.reminderMinutes + ' minutes (**' + event.at + '**).'
          : 'A server restart is scheduled for now (**' + event.at + '**).';
        await channel.send({
          embeds: [restartEmbed(title, description, reminder ? 0xFFFFFF : 0x00C49D)],
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      logger.warn('[RUST_RESTART] Could not process a scheduled notice:', error);
    }
  }
}
