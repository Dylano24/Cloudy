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

const SETTINGS = {
  panel_channel: {
    field: 'ticketPanelChannelId',
    title: 'Panel Channel',
    description: 'Choose where the support panel should be posted.',
    clearable: false,
  },
  logs_channel: {
    field: 'ticketLogsChannelId',
    title: 'Ticket Logs Channel',
    description: 'Choose where ticket lifecycle logs should be posted.',
    clearable: true,
  },
  transcript_channel: {
    field: 'ticketTranscriptChannelId',
    title: 'Transcript Channel',
    description: 'Choose where ticket transcripts should be posted.',
    clearable: true,
  },
};

const TYPE_NAMES = new Map([
  [ChannelType.GuildText, 'Text'],
  [ChannelType.GuildVoice, 'Voice'],
  [ChannelType.GuildCategory, 'Category'],
  [ChannelType.GuildAnnouncement, 'Announcement'],
  [ChannelType.AnnouncementThread, 'Announcement thread'],
  [ChannelType.PublicThread, 'Public thread'],
  [ChannelType.PrivateThread, 'Private thread'],
  [ChannelType.GuildStageVoice, 'Stage'],
  [ChannelType.GuildDirectory, 'Directory'],
  [ChannelType.GuildForum, 'Forum'],
  [ChannelType.GuildMedia, 'Media'],
]);

function channelTypeName(channel) {
  return TYPE_NAMES.get(channel.type) || `Channel type ${channel.type}`;
}

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
    case ChannelType.AnnouncementThread:
      return '🧵';
    default: return '•';
  }
}

function isPublicToEveryone(guild, channel) {
  try {
    return Boolean(channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
  } catch {
    return false;
  }
}

function channelSortKey(channel) {
  const parentPosition = channel.parent?.rawPosition ?? channel.rawPosition ?? 0;
  const ownPosition = channel.rawPosition ?? 0;
  return [parentPosition, ownPosition, String(channel.name || channel.id).toLowerCase()];
}

function compareChannels(a, b) {
  const ak = channelSortKey(a);
  const bk = channelSortKey(b);
  return ak[0] - bk[0] || ak[1] - bk[1] || ak[2].localeCompare(bk[2]);
}

export function isAllChannelTicketSetting(setting) {
  return Boolean(SETTINGS[setting]);
}

export async function refreshAllTicketChannels(guild) {
  const tasks = [guild.channels.fetch()];
  if (typeof guild.channels.fetchActiveThreads === 'function') {
    tasks.push(guild.channels.fetchActiveThreads());
  }
  await Promise.allSettled(tasks);
}

export function getEveryGuildChannel(guild) {
  return [...guild.channels.cache.values()]
    .filter(Boolean)
    .sort(compareChannels);
}

function buildChannelOption(guild, channel, currentId) {
  const visibility = isPublicToEveryone(guild, channel) ? 'Public' : 'Private';
  const parent = channel.parent?.name ? ` • ${channel.parent.name}` : '';
  const type = channelTypeName(channel);
  const name = String(channel.name || channel.id);

  return new StringSelectMenuOptionBuilder()
    .setLabel(`${channelIcon(channel)} ${name}`.slice(0, 100))
    .setDescription(`${visibility} • ${type}${parent} • ${channel.id}`.slice(0, 100))
    .setValue(channel.id)
    .setDefault(String(currentId || '') === String(channel.id));
}

function buildChannelSelect(guild, setting, definition, channels, startIndex, total, config) {
  const segment = channels.slice(startIndex, startIndex + SELECT_SIZE);
  if (!segment.length) return null;

  const first = startIndex + 1;
  const last = startIndex + segment.length;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket_dashboard_value:${guild.id}:${definition.field}:${setting}:${startIndex}`)
    .setPlaceholder(`Channels ${first}-${last} of ${total}`)
    .setMinValues(1)
    .setMaxValues(1);

  select.addOptions(...segment.map(channel =>
    buildChannelOption(guild, channel, config?.[definition.field]),
  ));

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
    .setDescription(
      `${definition.description}\n\n` +
      `**Current:** ${currentId ? `<#${currentId}>` : '`Not set`'}\n` +
      `**All Discord channels loaded:** ${channels.length}\n` +
      `**Showing:** ${channels.length ? `${pageStart + 1}-${pageEnd}` : '0'} of ${channels.length} • Page ${safePage + 1}/${pageCount}\n\n` +
      'Nothing is hidden by channel type or public/private status. If Discord exposes the channel to Cloudy, it appears here. ' +
      'Cloudy validates whether the selected channel can actually be used only after you select it.'
    )
    .setColor('#FFFFFF')
    .setFooter({ text: CLOUDY_TICKET_FOOTER });

  const components = [];
  for (let offset = 0; offset < pageChannels.length; offset += SELECT_SIZE) {
    const row = buildChannelSelect(
      guild,
      setting,
      definition,
      pageChannels,
      offset,
      channels.length,
      config,
    );
    if (row) components.push(row);
  }

  const buttons = [];
  if (definition.clearable) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ticket_dashboard_clear:${guild.id}:${definition.field}`)
        .setLabel('Clear')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✖️'),
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_manual:${guild.id}:${definition.field}`)
      .setLabel('Set by ID')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⌨️'),
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_page:${guild.id}:${setting}:${Math.max(0, safePage - 1)}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_page:${guild.id}:${setting}:${Math.min(pageCount - 1, safePage + 1)}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= pageCount - 1),
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_back:${guild.id}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('↩️'),
  );

  // Discord supports at most five action rows. Four dropdown rows expose up to
  // 100 channels at once; the fifth row is reserved for navigation/actions.
  components.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));

  return {
    content: pageChannels.length ? '' : 'Discord returned no channels for this server.',
    embeds: [embed],
    components,
  };
}
