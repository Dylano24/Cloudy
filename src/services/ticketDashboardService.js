import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { getColor } from '../config/bot.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

export const TICKET_DASHBOARD_CLEAR_VALUE = '__clear__';

const DEFAULT_PANEL_MESSAGE = 'Click the button below to create a support ticket.';
const DEFAULT_BUTTON_LABEL = 'Start Chat';

const SETTING_DEFINITIONS = {
  panel_channel: {
    field: 'ticketPanelChannelId',
    type: 'text_channel',
    title: 'Panel Channel',
    description: 'Choose where the support panel should be posted.',
  },
  open_category: {
    field: 'ticketCategoryId',
    type: 'category',
    title: 'Open Tickets Category',
    description: 'Choose the category where new tickets are created.',
  },
  closed_category: {
    field: 'ticketClosedCategoryId',
    type: 'category',
    title: 'Closed Tickets Category',
    description: 'Choose the category where closed tickets are moved.',
  },
  logs_channel: {
    field: 'ticketLogsChannelId',
    type: 'text_channel',
    title: 'Ticket Logs Channel',
    description: 'Choose the channel used for ticket lifecycle logs.',
  },
  transcript_channel: {
    field: 'ticketTranscriptChannelId',
    type: 'text_channel',
    title: 'Transcript Channel',
    description: 'Choose the channel used for ticket transcripts.',
  },
  staff_role: {
    field: 'ticketStaffRoleId',
    type: 'role',
    title: 'Ticket Staff Role',
    description: 'Choose the role that can manage tickets.',
  },
  max_tickets: {
    field: 'maxTicketsPerUser',
    type: 'number',
    title: 'Max Tickets per User',
    description: 'Choose how many open tickets one member can have.',
  },
};

function buildTicketPanelEmbed(client, config) {
  const avatarUrl = client.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
  const embed = new EmbedBuilder()
    .setTitle('Contact the support')
    .setDescription(config.ticketPanelMessage || DEFAULT_PANEL_MESSAGE)
    .setColor(getColor('info'))
    .setFooter({
      text: 'Cloudy Support',
      ...(avatarUrl ? { iconURL: avatarUrl } : {}),
    });

  if (avatarUrl) embed.setThumbnail(avatarUrl);
  return embed;
}

function buildTicketPanelButton(config) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel(config.ticketButtonLabel || DEFAULT_BUTTON_LABEL)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('💬'),
  );
}

export function buildTicketPanelPayload(client, config) {
  return {
    embeds: [buildTicketPanelEmbed(client, config)],
    components: [buildTicketPanelButton(config)],
  };
}

function hasCreateTicketButton(message) {
  return message?.components?.some(row =>
    row.components?.some(component => component.customId === 'create_ticket')
  );
}

export async function findTicketPanelMessage(client, guild, config) {
  if (!config?.ticketPanelChannelId) return null;

  const channel = guild.channels.cache.get(config.ticketPanelChannelId)
    || await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return null;

  if (config.ticketPanelMessageId) {
    const configured = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
    if (configured?.author?.id === client.user.id && hasCreateTicketButton(configured)) {
      return configured;
    }
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return recent?.find(message =>
    message.author?.id === client.user.id && hasCreateTicketButton(message)
  ) || null;
}

export async function updateLiveTicketPanel(client, guild, config) {
  const panel = await findTicketPanelMessage(client, guild, config);
  if (!panel) return false;

  await panel.edit(buildTicketPanelPayload(client, config));

  if (config.ticketPanelMessageId !== panel.id) {
    await updateGuildConfig(client, guild.id, { ticketPanelMessageId: panel.id });
  }

  return true;
}

export async function moveTicketPanel(client, guild, newChannelId) {
  const config = await getGuildConfig(client, guild.id);
  const newChannel = guild.channels.cache.get(newChannelId)
    || await guild.channels.fetch(newChannelId).catch(() => null);

  if (!newChannel?.isTextBased?.() || !newChannel.isSendable?.()) {
    const error = new Error('Selected panel channel is not sendable.');
    error.userMessage = 'That channel cannot be used for the ticket panel.';
    throw error;
  }

  const oldPanel = await findTicketPanelMessage(client, guild, config);
  const sent = await newChannel.send(buildTicketPanelPayload(client, config));

  let saved;
  try {
    saved = await updateGuildConfig(client, guild.id, {
      ticketPanelChannelId: newChannelId,
      ticketPanelMessageId: sent.id,
      dmOnClose: false,
    });
  } catch (error) {
    await sent.delete().catch(() => {});
    throw error;
  }

  if (oldPanel && oldPanel.id !== sent.id) {
    await oldPanel.delete().catch(() => {});
  }

  return saved;
}

export async function repostTicketPanel(client, guild) {
  const config = await getGuildConfig(client, guild.id);
  if (!config.ticketPanelChannelId) {
    const error = new Error('Ticket panel channel is not configured.');
    error.userMessage = 'Choose a panel channel first.';
    throw error;
  }

  const channel = guild.channels.cache.get(config.ticketPanelChannelId)
    || await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.isSendable?.()) {
    const error = new Error('Configured ticket panel channel is unavailable.');
    error.userMessage = 'The configured panel channel is unavailable. Choose a new one first.';
    throw error;
  }

  const oldPanel = await findTicketPanelMessage(client, guild, config);
  const sent = await channel.send(buildTicketPanelPayload(client, config));

  let saved;
  try {
    saved = await updateGuildConfig(client, guild.id, {
      ticketPanelMessageId: sent.id,
      dmOnClose: false,
    });
  } catch (error) {
    await sent.delete().catch(() => {});
    throw error;
  }

  if (oldPanel && oldPanel.id !== sent.id) {
    await oldPanel.delete().catch(() => {});
  }

  return { panel: sent, config: saved };
}

export async function deleteTicketSystem(client, guild) {
  const config = await getGuildConfig(client, guild.id);
  const panel = await findTicketPanelMessage(client, guild, config);

  const saved = await updateGuildConfig(client, guild.id, {
    ticketPanelChannelId: null,
    ticketPanelMessageId: null,
    ticketPanelMessage: null,
    ticketButtonLabel: DEFAULT_BUTTON_LABEL,
    ticketCategoryId: null,
    ticketClosedCategoryId: null,
    ticketStaffRoleId: null,
    ticketLogsChannelId: null,
    ticketTranscriptChannelId: null,
    maxTicketsPerUser: 3,
    dmOnClose: false,
  });

  if (panel) await panel.delete().catch(() => {});
  return saved;
}

export async function saveTicketDashboardSetting(client, guild, field, value) {
  const allowedFields = new Set([
    'ticketPanelMessage',
    'ticketButtonLabel',
    'ticketCategoryId',
    'ticketClosedCategoryId',
    'ticketStaffRoleId',
    'ticketLogsChannelId',
    'ticketTranscriptChannelId',
    'maxTicketsPerUser',
  ]);

  if (!allowedFields.has(field)) {
    const error = new Error(`Unsupported ticket dashboard field: ${field}`);
    error.userMessage = 'That ticket setting cannot be changed.';
    throw error;
  }

  const saved = await updateGuildConfig(client, guild.id, {
    [field]: value,
    dmOnClose: false,
  });

  if (field === 'ticketPanelMessage' || field === 'ticketButtonLabel') {
    await updateLiveTicketPanel(client, guild, saved).catch(() => {});
  }

  return saved;
}

function buildDashboardSelect(guildId) {
  return new StringSelectMenuBuilder()
    .setCustomId(`ticket_dashboard_select:${guildId}`)
    .setPlaceholder('Select a setting to configure...')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Edit Panel Message').setDescription('Change the panel description').setValue('panel_message').setEmoji('📝'),
      new StringSelectMenuOptionBuilder().setLabel('Edit Button Label').setDescription('Change the Start Chat button label').setValue('button_label').setEmoji('🏷️'),
      new StringSelectMenuOptionBuilder().setLabel('Change Panel Channel').setDescription('Move the support panel to another channel').setValue('panel_channel').setEmoji('💬'),
      new StringSelectMenuOptionBuilder().setLabel('Change Open Tickets Category').setDescription('Category where new tickets are created').setValue('open_category').setEmoji('📁'),
      new StringSelectMenuOptionBuilder().setLabel('Change Closed Tickets Category').setDescription('Category where closed tickets are moved').setValue('closed_category').setEmoji('📂'),
      new StringSelectMenuOptionBuilder().setLabel('Set Max Tickets per User').setDescription('Limit open tickets per member').setValue('max_tickets').setEmoji('🔢'),
      new StringSelectMenuOptionBuilder().setLabel('Set Ticket Logs Channel').setDescription('Channel for ticket lifecycle logs').setValue('logs_channel').setEmoji('🎫'),
      new StringSelectMenuOptionBuilder().setLabel('Set Transcript Channel').setDescription('Channel for ticket transcripts').setValue('transcript_channel').setEmoji('📜'),
    );
}

function buildDashboardButtons(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_repost:${guildId}`)
      .setLabel('Repost Panel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_staff:${guildId}`)
      .setLabel('Staff Role')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🛡️'),
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_delete:${guildId}`)
      .setLabel('Delete System')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
  );
}

export function buildTicketDashboardPayload(guild, config) {
  const panelMessage = config.ticketPanelMessage || DEFAULT_PANEL_MESSAGE;
  const shortMessage = panelMessage.length > 90 ? `${panelMessage.slice(0, 90)}…` : panelMessage;

  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket System Dashboard')
    .setDescription(`Manage the ticket system for **${guild.name}**. Changes are saved persistently as soon as you confirm them.`)
    .setColor(getColor('info'))
    .addFields(
      { name: 'Panel Channel', value: config.ticketPanelChannelId ? `<#${config.ticketPanelChannelId}>` : '`Not set`', inline: true },
      { name: 'Staff Role', value: config.ticketStaffRoleId ? `<@&${config.ticketStaffRoleId}>` : '`Not set`', inline: true },
      { name: 'Private Close DMs', value: 'Disabled', inline: true },
      { name: 'Open Tickets Category', value: config.ticketCategoryId ? `<#${config.ticketCategoryId}>` : '`Not set`', inline: true },
      { name: 'Closed Tickets Category', value: config.ticketClosedCategoryId ? `<#${config.ticketClosedCategoryId}>` : '`Not set`', inline: true },
      { name: 'Max Tickets/User', value: String(config.maxTicketsPerUser ?? 3), inline: true },
      { name: 'Ticket Logs Channel', value: config.ticketLogsChannelId ? `<#${config.ticketLogsChannelId}>` : '`Not set`', inline: true },
      { name: 'Transcript Channel', value: config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : '`Not set`', inline: true },
      { name: 'Button Label', value: `\`${config.ticketButtonLabel || DEFAULT_BUTTON_LABEL}\``, inline: true },
      { name: 'Panel Message', value: `\`${shortMessage.replace(/`/g, "'")}\``, inline: false },
    )
    .setFooter({ text: 'Cloudy Support • Settings are stored in PostgreSQL' });

  return {
    content: '',
    embeds: [embed],
    components: [
      buildDashboardButtons(guild.id),
      new ActionRowBuilder().addComponents(buildDashboardSelect(guild.id)),
    ],
  };
}

function getSortedChannels(guild, type) {
  return [...guild.channels.cache.values()]
    .filter(channel => channel.type === type)
    .sort((a, b) => a.rawPosition - b.rawPosition);
}

function buildValueOptions(guild, definition, config) {
  const options = [];

  if (definition.type === 'number') {
    for (let value = 1; value <= 10; value += 1) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${value} ticket${value === 1 ? '' : 's'}`)
          .setValue(String(value))
          .setDefault(Number(config.maxTicketsPerUser ?? 3) === value),
      );
    }
    return options;
  }

  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel('Not set / None')
      .setValue(TICKET_DASHBOARD_CLEAR_VALUE)
      .setEmoji('✖️')
      .setDefault(!config[definition.field]),
  );

  if (definition.type === 'role') {
    const roles = [...guild.roles.cache.values()]
      .filter(role => role.id !== guild.id && !role.managed)
      .sort((a, b) => b.position - a.position)
      .slice(0, 24);

    for (const role of roles) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(role.name.slice(0, 100))
          .setValue(role.id)
          .setDefault(config[definition.field] === role.id),
      );
    }
    return options;
  }

  const channelType = definition.type === 'category'
    ? ChannelType.GuildCategory
    : ChannelType.GuildText;

  const channels = getSortedChannels(guild, channelType).slice(0, 24);
  for (const channel of channels) {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(channel.name.slice(0, 100))
        .setValue(channel.id)
        .setDefault(config[definition.field] === channel.id),
    );
  }

  return options;
}

export function getTicketDashboardSettingDefinition(setting) {
  return SETTING_DEFINITIONS[setting] || null;
}

export function buildTicketDashboardValuePrompt(guild, setting, config) {
  const definition = getTicketDashboardSettingDefinition(setting);
  if (!definition) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket_dashboard_value:${guild.id}:${definition.field}`)
    .setPlaceholder(`Choose ${definition.title.toLowerCase()}...`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(buildValueOptions(guild, definition, config));

  const back = new ButtonBuilder()
    .setCustomId(`ticket_dashboard_back:${guild.id}`)
    .setLabel('Back')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('↩️');

  const embed = new EmbedBuilder()
    .setTitle(definition.title)
    .setDescription(definition.description)
    .setColor(getColor('info'));

  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(back),
    ],
  };
}

export async function getCurrentTicketDashboardConfig(client, guildId) {
  return await getGuildConfig(client, guildId);
}
