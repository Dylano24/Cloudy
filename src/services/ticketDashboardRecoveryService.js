import { ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const PANEL_TITLES = new Set(['contact the support', 'cloudy support']);
const PANEL_BUTTON_LABELS = new Set(['start chat', 'create ticket']);
const FETCH_LIMIT = 100;
const MAX_LIKELY_PAGES = 3;

function componentRows(message) {
  return message?.components?.flatMap(row => row.components || []) || [];
}

function isCloudyTicketPanel(message, botId) {
  if (!message || message.author?.id !== botId) return false;

  const components = componentRows(message);
  if (components.some(component => component.customId === 'create_ticket')) return true;

  const title = String(message.embeds?.[0]?.title || '').trim().toLowerCase();
  if (PANEL_TITLES.has(title)) return true;

  return components.some(component =>
    PANEL_BUTTON_LABELS.has(String(component.label || '').trim().toLowerCase()),
  );
}

function panelButton(message) {
  return componentRows(message).find(component =>
    component.customId === 'create_ticket'
    || PANEL_BUTTON_LABELS.has(String(component.label || '').trim().toLowerCase()),
  ) || null;
}

function likelyPanelChannel(channel) {
  const name = String(channel?.name || '').toLowerCase();
  return (
    name === 'contact-support'
    || name === 'ticket-support'
    || name === 'support-tickets'
    || name.includes('support')
    || name.includes('ticket')
  );
}

async function findPanelInChannel(channel, botId, deep = false) {
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return null;

  let before;
  const pages = deep ? MAX_LIKELY_PAGES : 1;

  for (let page = 0; page < pages; page += 1) {
    const options = { limit: FETCH_LIMIT };
    if (before) options.before = before;

    const messages = await channel.messages.fetch(options).catch(() => null);
    if (!messages?.size) return null;

    const found = messages.find(message => isCloudyTicketPanel(message, botId));
    if (found) return found;

    before = messages.last()?.id;
    if (!before || messages.size < FETCH_LIMIT) break;
  }

  return null;
}

function scoreChannel(channel, preferredChannelId) {
  if (channel.id === preferredChannelId) return -1000;
  const name = String(channel.name || '').toLowerCase();
  if (name === 'contact-support') return -950;
  if (name.includes('contact-support')) return -925;
  if (name.includes('support')) return -900;
  if (name.includes('ticket')) return -850;
  if (name.includes('help')) return -800;
  return channel.rawPosition ?? 0;
}

function candidateTextChannels(guild, preferredChannelId) {
  return [...guild.channels.cache.values()]
    .filter(channel =>
      channel.type === ChannelType.GuildText
      && channel.id !== preferredChannelId
      && channel.messages?.fetch,
    )
    .sort((a, b) => scoreChannel(a, preferredChannelId) - scoreChannel(b, preferredChannelId));
}

async function scanChannels(channels, botId) {
  const likely = channels.filter(likelyPanelChannel);
  const rest = channels.filter(channel => !likelyPanelChannel(channel));

  // Search likely support/ticket channels first and a little deeper. This is the
  // common Cloudy case and avoids scanning every server channel first.
  for (let index = 0; index < likely.length; index += 4) {
    const batch = likely.slice(index, index + 4);
    const results = await Promise.all(batch.map(async channel => ({
      channel,
      panel: await findPanelInChannel(channel, botId, true),
    })));
    const found = results.find(result => result.panel);
    if (found) return found;
  }

  // Non-support channels only get one recent page; recovery must stay bounded.
  for (let index = 0; index < rest.length; index += 6) {
    const batch = rest.slice(index, index + 6);
    const results = await Promise.all(batch.map(async channel => ({
      channel,
      panel: await findPanelInChannel(channel, botId, false),
    })));
    const found = results.find(result => result.panel);
    if (found) return found;
  }

  return null;
}

async function findExistingPanel(guild, botId, preferredChannelId) {
  const preferred = preferredChannelId
    ? guild.channels.cache.get(preferredChannelId)
    : null;

  if (preferred?.type === ChannelType.GuildText) {
    const panel = await findPanelInChannel(preferred, botId, likelyPanelChannel(preferred));
    if (panel) return { channel: preferred, panel };
  }

  // First use the gateway cache immediately. Most guilds already have the full
  // channel inventory, so recovery should not wait on a Discord REST refresh.
  let channels = candidateTextChannels(guild, preferredChannelId);
  let found = await scanChannels(channels, botId);
  if (found) return found;

  // Only if cache recovery failed, refresh Discord once and inspect any channels
  // that were not present before.
  const knownIds = new Set(channels.map(channel => channel.id));
  await guild.channels.fetch().catch(() => {});
  channels = candidateTextChannels(guild, preferredChannelId)
    .filter(channel => !knownIds.has(channel.id));

  if (channels.length) {
    found = await scanChannels(channels, botId);
    if (found) return found;
  }

  return null;
}

function findCategory(guild, patterns) {
  const categories = [...guild.channels.cache.values()]
    .filter(channel => channel.type === ChannelType.GuildCategory);
  return categories.find(channel => patterns.some(pattern => pattern.test(channel.name))) || null;
}

function findTextChannel(guild, patterns) {
  return [...guild.channels.cache.values()].find(channel =>
    channel.type === ChannelType.GuildText
    && patterns.some(pattern => pattern.test(channel.name)),
  ) || null;
}

function fallbackPanelChannel(guild, preferredChannelId) {
  const preferred = preferredChannelId ? guild.channels.cache.get(preferredChannelId) : null;
  if (preferred?.type === ChannelType.GuildText && likelyPanelChannel(preferred)) return preferred;

  return findTextChannel(guild, [
    /^contact[-_ ]support$/i,
    /^ticket[-_ ]support$/i,
    /^support[-_ ]tickets?$/i,
  ]);
}

export async function recoverTicketDashboardConfig(client, guild, preferredChannelId = null) {
  const current = await getGuildConfig(client, guild.id);
  if (current?.ticketPanelChannelId) return current;

  const found = await findExistingPanel(guild, client.user?.id, preferredChannelId);
  const fallbackChannel = found?.channel || fallbackPanelChannel(guild, preferredChannelId);
  if (!fallbackChannel) return current;

  const panel = found?.panel || null;
  const button = panel ? panelButton(panel) : null;
  const openCategory = findCategory(guild, [
    /^tickets?$/i,
    /open.*ticket|ticket.*open/i,
    /support.*help|help.*support/i,
  ]);
  const closedCategory = findCategory(guild, [/closed.*ticket|ticket.*closed/i]);
  const staffRole = guild.roles.cache.find(role =>
    ['owner', 'admin', 'administrator', 'staff', 'support'].includes(role.name.trim().toLowerCase()),
  ) || null;
  const logsChannel = findTextChannel(guild, [/^(ticket|tickets)[-_ ]?logs$/i]);
  const transcriptChannel = findTextChannel(guild, [/^(ticket|tickets)[-_ ]?transcripts?$/i]);

  const recovered = await updateGuildConfig(client, guild.id, {
    ticketPanelChannelId: fallbackChannel.id,
    ticketPanelMessageId: panel?.id || current.ticketPanelMessageId || null,
    ticketPanelMessage:
      panel?.embeds?.[0]?.description
      || current.ticketPanelMessage
      || 'Click the button below to create a support ticket.',
    ticketButtonLabel:
      button?.label
      || current.ticketButtonLabel
      || 'Start Chat',
    ticketCategoryId: current.ticketCategoryId || openCategory?.id || null,
    ticketClosedCategoryId: current.ticketClosedCategoryId || closedCategory?.id || null,
    ticketStaffRoleId: current.ticketStaffRoleId || staffRole?.id || null,
    ticketLogsChannelId: current.ticketLogsChannelId || logsChannel?.id || null,
    ticketTranscriptChannelId: current.ticketTranscriptChannelId || transcriptChannel?.id || null,
    maxTicketsPerUser: Number(current.maxTicketsPerUser) || 3,
    dmOnClose: false,
  });

  logger.info('Recovered existing Cloudy ticket dashboard configuration', {
    guildId: guild.id,
    panelChannelId: fallbackChannel.id,
    panelMessageId: panel?.id || null,
    inferredPanelChannel: !panel,
  });

  return recovered;
}
