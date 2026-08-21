import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { CLOUDY_TICKET_FOOTER } from './ticketPanelBuilder.js';

const PAGE_SIZE = 100;
const SELECT_SIZE = 25;
const REFRESH_TTL_MS = 15000;
const refreshTimes = new Map();
const refreshJobs = new Map();

const SETTINGS = {
  panel_channel: { field: 'ticketPanelChannelId', title: 'Panel Channel', description: 'Choose where the support panel should be posted.', clearable: false },
  logs_channel: { field: 'ticketLogsChannelId', title: 'Ticket Logs Channel', description: 'Choose where ticket lifecycle logs should be posted.', clearable: true },
  transcript_channel: { field: 'ticketTranscriptChannelId', title: 'Transcript Channel', description: 'Choose where ticket transcripts should be posted.', clearable: true },
};

const TYPE_NAMES = new Map([
  [ChannelType.GuildText, 'Text'], [ChannelType.GuildVoice, 'Voice'], [ChannelType.GuildCategory, 'Category'],
  [ChannelType.GuildAnnouncement, 'Announcement'], [ChannelType.AnnouncementThread, 'Announcement thread'],
  [ChannelType.PublicThread, 'Public thread'], [ChannelType.PrivateThread, 'Private thread'],
  [ChannelType.GuildStageVoice, 'Stage'], [ChannelType.GuildDirectory, 'Directory'],
  [ChannelType.GuildForum, 'Forum'], [ChannelType.GuildMedia, 'Media'],
]);

function channelTypeName(channel) { return TYPE_NAMES.get(channel.type) || `Channel type ${channel.type}`; }
function channelIcon(channel) {
  switch (channel.type) {
    case ChannelType.GuildText: return '#';
    case ChannelType.GuildAnnouncement: return '📢';
    case ChannelType.GuildVoice: return '🔊';
    case ChannelType.GuildCategory: return '📁';
    case ChannelType.GuildStageVoice: return '🎙️';
    case ChannelType.GuildForum: return '💬';
    case ChannelType.GuildMedia: return '🖼️';
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread: return '🧵';
    default: return '•';
  }
}

function isPublicToEveryone(guild, channel) {
  try { return Boolean(channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)); }
  catch { return false; }
}
function isUsableTicketDestination(channel) { return [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type); }
function channelSortKey(channel) {
  return [channel.parent?.rawPosition ?? channel.rawPosition ?? 0, channel.rawPosition ?? 0, String(channel.name || channel.id).toLowerCase()];
}
function compareChannels(a, b) {
  const ak = channelSortKey(a); const bk = channelSortKey(b);
  return ak[0] - bk[0] || ak[1] - bk[1] || ak[2].localeCompare(bk[2]);
}

export function isAllChannelTicketSetting(setting) { return Boolean(SETTINGS[setting]); }

export async function refreshAllTicketChannels(guild, force = false) {
  if (!guild?.id) return;
  const now = Date.now();
  if (!force && now - (refreshTimes.get(guild.id) || 0) < REFRESH_TTL_MS) return;
  if (refreshJobs.has(guild.id)) return await refreshJobs.get(guild.id);

  const job = (async () => {
    try {
      const tasks = [];
      try { tasks.push(Promise.resolve(guild.channels.fetch()).catch(() => null)); } catch {}
      try {
        if (typeof guild.channels.fetchActiveThreads === 'function') {
          tasks.push(Promise.resolve(guild.channels.fetchActiveThreads()).catch(() => null));
        }
      } catch {}
      if (tasks.length) await Promise.allSettled(tasks);
      refreshTimes.set(guild.id, Date.now());
    } finally {
      refreshJobs.delete(guild.id);
    }
  })();

  refreshJobs.set(guild.id, job);
  await job;
}

export function getEveryGuildChannel(guild) {
  return [...guild.channels.cache.values()].filter(Boolean).sort(compareChannels);
}

function buildChannelOption(guild, channel, currentId) {
  const visibility = isPublicToEveryone(guild, channel) ? 'Public' : 'Private';
  const compatibility = isUsableTicketDestination(channel) ? 'Usable' : 'Visible only';
  const parent = channel.parent?.name ? ` • ${channel.parent.name}` : '';
  return new StringSelectMenuOptionBuilder()
    .setLabel(`${channelIcon(channel)} ${String(channel.name || channel.id)}`.slice(0, 100))
    .setDescription(`${visibility} • ${channelTypeName(channel)} • ${compatibility}${parent} • ${channel.id}`.slice(0, 100))
    .setValue(channel.id)
    .setDefault(String(currentId || '') === String(channel.id));
}

function buildChannelSelect(guild, setting, definition, pageChannels, localStart, globalStart, total, page, config) {
  const segment = pageChannels.slice(localStart, localStart + SELECT_SIZE);
  if (!segment.length) return null;
  const first = globalStart + localStart + 1;
  const last = first + segment.length - 1;
  const segmentIndex = Math.floor(localStart / SELECT_SIZE);
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket_dashboard_value:${guild.id}:${definition.field}:${setting}:${page}:${segmentIndex}`)
    .setPlaceholder(`Channels ${first}-${last} of ${total}`)
    .setMinValues(1).setMaxValues(1);
  select.addOptions(...segment.map(channel => buildChannelOption(guild, channel, config?.[definition.field])));
  return new ActionRowBuilder().addComponents(select);
}

export function buildAllChannelTicketPrompt(guild, setting, config = {}, page = 0) {
  const definition = SETTINGS[setting];
  if (!definition) return null;
  const channels = getEveryGuildChannel(guild);
  const pageCount = Math.max(1, Math.ceil(channels.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const pageChannels = channels.slice(pageStart, pageStart + PAGE_SIZE);
  const pageEnd = pageStart + pageChannels.length;
  const currentId = config?.[definition.field] || null;

  const embed = new EmbedBuilder()
    .setTitle(definition.title)
    .setDescription(`${definition.description}\n\n**Current:** ${currentId ? `<#${currentId}>` : '`Not set`'}\n**All Discord channels loaded:** ${channels.length}\n**Showing:** ${channels.length ? `${pageStart + 1}-${pageEnd}` : '0'} of ${channels.length} • Page ${safePage + 1}/${pageCount}\n\nNothing is hidden by channel type or public/private status. **Usable** means Cloudy can potentially use that channel for this ticket setting; **Visible only** means it is shown so nothing is missing, but Discord does not allow that channel type for this destination.`)
    .setColor('#FFFFFF')
    .setFooter({ text: CLOUDY_TICKET_FOOTER });

  const components = [];
  for (let offset = 0; offset < pageChannels.length; offset += SELECT_SIZE) {
    const row = buildChannelSelect(guild, setting, definition, pageChannels, offset, pageStart, channels.length, safePage, config);
    if (row) components.push(row);
  }

  const buttons = [];
  if (definition.clearable) {
    buttons.push(new ButtonBuilder().setCustomId(`ticket_dashboard_clear:${guild.id}:${definition.field}`).setLabel('Clear').setStyle(ButtonStyle.Secondary).setEmoji('✖️'));
  }
  buttons.push(
    new ButtonBuilder().setCustomId(`ticket_dashboard_manual:${guild.id}:${definition.field}`).setLabel('Set by ID').setStyle(ButtonStyle.Secondary).setEmoji('⌨️'),
    new ButtonBuilder().setCustomId(`ticket_dashboard_page:${guild.id}:${setting}:${Math.max(0, safePage - 1)}:previous`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`ticket_dashboard_page:${guild.id}:${setting}:${Math.min(pageCount - 1, safePage + 1)}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    new ButtonBuilder().setCustomId(`ticket_dashboard_back:${guild.id}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
  );
  components.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));

  return { content: pageChannels.length ? '' : 'Discord returned no channels for this server.', embeds: [embed], components };
}
