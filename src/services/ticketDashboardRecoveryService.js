import { ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const PANEL_TITLES = new Set(['contact the support', 'cloudy support']);
const PANEL_BUTTON_LABELS = new Set(['start chat', 'create ticket']);
const FETCH_LIMIT = 100;

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

async function findPanelInChannel(channel, botId) {
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return null;

  const messages = await channel.messages.fetch({ limit: FETCH_LIMIT }).catch(() => null);
  if (!messages) return null;

  return messages.find(message => isCloudyTicketPanel(message, botId)) || null;
}

function scoreChannel(channel, preferredChannelId) {
  if (channel.id === preferredChannelId) return -1000;
  const name = String(channel.name || '').toLowerCase();
  if (name.includes('contact-support')) return -900;
  if (name.includes('support')) return -800;
  if (name.includes('ticket')) return -700;
  if (name.includes('help')) return -600;
  return channel.rawPosition ?? 0;
}

async function findExistingPanel(guild, botId, preferredChannelId) {
  const preferred = preferredChannelId
    ? guild.channels.cache.get(preferredChannelId)
    : null;

  if (preferred) {
    const panel = await findPanelInChannel(preferred, botId);
    if (panel) return { channel: preferred, panel };
  }

  await guild.channels.fetch().catch(() => {});

  const channels = [...guild.channels.cache.values()]
    .filter(channel =>
      channel.type === ChannelType.GuildText
      && channel.id !== preferredChannelId
      && channel.messages?.fetch,
    )
    .sort((a, b) => scoreChannel(a, preferredChannelId) - scoreChannel(b, preferredChannelId));

  // Search likely support/ticket channels first. Small batches avoid one slow or
  // inaccessible channel blocking the whole dashboard recovery.
  for (let index = 0; index < channels.length; index += 5) {
    const batch = channels.slice(index, index + 5);
    const results = await Promise.all(batch.map(async channel => ({
      channel,
      panel: await findPanelInChannel(channel, botId),
    })));
    const found = results.find(result => result.panel);
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

export async function recoverTicketDashboardConfig(client, guild, preferredChannelId = null) {
  const current = await getGuildConfig(client, guild.id);
  if (current?.ticketPanelChannelId) return current;

  const found = await findExistingPanel(guild, client.user?.id, preferredChannelId);
  if (!found) return current;

  const button = panelButton(found.panel);
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
    ticketPanelChannelId: found.channel.id,
    ticketPanelMessageId: found.panel.id,
    ticketPanelMessage:
      found.panel.embeds?.[0]?.description
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
    panelChannelId: found.channel.id,
    panelMessageId: found.panel.id,
  });

  return recovered;
}
