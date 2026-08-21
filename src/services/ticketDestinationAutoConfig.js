import { ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

function isTextDestination(channel) {
  return Boolean(
    channel
    && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type),
  );
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function looksLikeLogsChannel(channel) {
  const name = normalizeName(channel?.name);
  return name.includes('ticket-logs')
    || name.includes('tickets-logs')
    || name.endsWith('ticket-log');
}

function looksLikeTranscriptChannel(channel) {
  const name = normalizeName(channel?.name);
  return name.includes('ticket-transcript')
    || name.includes('tickets-transcript')
    || name.endsWith('transcript')
    || name.endsWith('transcripts');
}

function findMatchingChannel(guild, matcher) {
  return [...guild.channels.cache.values()]
    .filter(isTextDestination)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .find(matcher) || null;
}

export async function ensureTicketDestinationConfig(client, guild, { refreshIfMissing = false } = {}) {
  let config = await getGuildConfig(client, guild.id);
  if (config.ticketLogsChannelId && config.ticketTranscriptChannelId) return config;

  let logsChannel = config.ticketLogsChannelId ? guild.channels.cache.get(config.ticketLogsChannelId) : null;
  let transcriptChannel = config.ticketTranscriptChannelId ? guild.channels.cache.get(config.ticketTranscriptChannelId) : null;

  if (!logsChannel) logsChannel = findMatchingChannel(guild, looksLikeLogsChannel);
  if (!transcriptChannel) transcriptChannel = findMatchingChannel(guild, looksLikeTranscriptChannel);

  if (refreshIfMissing && (!logsChannel || !transcriptChannel)) {
    await guild.channels.fetch().catch(() => {});
    if (!logsChannel) logsChannel = findMatchingChannel(guild, looksLikeLogsChannel);
    if (!transcriptChannel) transcriptChannel = findMatchingChannel(guild, looksLikeTranscriptChannel);
  }

  const updates = {};
  if (!config.ticketLogsChannelId && logsChannel) updates.ticketLogsChannelId = logsChannel.id;
  if (!config.ticketTranscriptChannelId && transcriptChannel) updates.ticketTranscriptChannelId = transcriptChannel.id;

  if (!Object.keys(updates).length) return config;
  config = await updateGuildConfig(client, guild.id, updates);
  return config;
}
