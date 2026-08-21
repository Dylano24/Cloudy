import { ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const LOG_PATTERNS = [
  /^ticket[-_ ]logs$/i,
  /^tickets[-_ ]logs$/i,
  /^ticket[-_ ]log$/i,
];

const TRANSCRIPT_PATTERNS = [
  /^ticket[-_ ]transcripts?$/i,
  /^tickets[-_ ]transcripts?$/i,
  /^transcripts?$/i,
];

function isTextDestination(channel) {
  return Boolean(
    channel
    && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type),
  );
}

function findMatchingChannel(guild, patterns) {
  return [...guild.channels.cache.values()]
    .filter(isTextDestination)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .find(channel => patterns.some(pattern => pattern.test(String(channel.name || '')))) || null;
}

export async function ensureTicketDestinationConfig(client, guild, { refreshIfMissing = false } = {}) {
  let config = await getGuildConfig(client, guild.id);
  if (config.ticketLogsChannelId && config.ticketTranscriptChannelId) return config;

  let logsChannel = config.ticketLogsChannelId ? guild.channels.cache.get(config.ticketLogsChannelId) : null;
  let transcriptChannel = config.ticketTranscriptChannelId ? guild.channels.cache.get(config.ticketTranscriptChannelId) : null;

  if (!logsChannel) logsChannel = findMatchingChannel(guild, LOG_PATTERNS);
  if (!transcriptChannel) transcriptChannel = findMatchingChannel(guild, TRANSCRIPT_PATTERNS);

  if (refreshIfMissing && (!logsChannel || !transcriptChannel)) {
    await guild.channels.fetch().catch(() => {});
    if (!logsChannel) logsChannel = findMatchingChannel(guild, LOG_PATTERNS);
    if (!transcriptChannel) transcriptChannel = findMatchingChannel(guild, TRANSCRIPT_PATTERNS);
  }

  const updates = {};
  if (!config.ticketLogsChannelId && logsChannel) updates.ticketLogsChannelId = logsChannel.id;
  if (!config.ticketTranscriptChannelId && transcriptChannel) updates.ticketTranscriptChannelId = transcriptChannel.id;

  if (!Object.keys(updates).length) return config;
  config = await updateGuildConfig(client, guild.id, updates);
  return config;
}
