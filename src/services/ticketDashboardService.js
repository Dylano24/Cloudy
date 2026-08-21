import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
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
    description: 'Choose any text channel, including private channels, for ticket lifecycle logs.',
  },
  transcript_channel: {
    field: 'ticketTranscriptChannelId',
    type: 'text_channel',
    title: 'Transcript Channel',
    description: 'Choose any text channel, including private channels, for ticket transcripts.',
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

const NULLABLE_FIELDS = new Set([
  'ticketCategoryId',
  'ticketClosedCategoryId',
  'ticketStaffRoleId',
  'ticketLogsChannelId',
  'ticketTranscriptChannelId',
]);

function dashboardError(message, userMessage) {
  const error = new Error(message);
  error.userMessage = userMessage;
  return error;
}

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

async function fetchGuildChannel(guild, channelId) {
  return guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
}

async function fetchGuildRole(guild, roleId) {
  return guild.roles.cache.get(roleId)
    || await guild.roles.fetch(roleId).catch(() => null);
}

function assertTextDestinationPermissions(guild, channel, { transcript = false } = {}) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw dashboardError(
      'Selected ticket destination is not a supported text channel.',
      'Choose a normal text or announcement channel.',
    );
  }

  if (!channel.isTextBased?.() || !channel.isSendable?.()) {
    throw dashboardError(
      'Selected ticket destination is not sendable.',
      'Cloudy cannot send messages in that channel.',
    );
  }

  const botMember = guild.members.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    ...(transcript ? [PermissionFlagsBits.AttachFiles] : []),
  ];

  if (!permissions || !permissions.has(required)) {
    const requirements = transcript
      ? '`View Channel`, `Send Messages`, `Embed Links` and `Attach Files`'
      : '`View Channel`, `Send Messages` and `Embed Links`';
    throw dashboardError(
      'Cloudy is missing permissions in the selected private channel.',
      `That channel is selectable, but Cloudy cannot use it yet. Give the bot ${requirements} in that channel and select it again.`,
    );
  }
}

export async function validateTicketDashboardValue(client, guild, field, value) {
  if (value == null) {
    if (!NULLABLE_FIELDS.has(field)) {
      throw dashboardError('Ticket setting cannot be cleared.', 'That ticket setting cannot be cleared.');
    }
    return null;
  }

  if (field === 'ticketPanelChannelId' || field === 'ticketLogsChannelId' || field === 'ticketTranscriptChannelId') {
    const channel = await fetchGuildChannel(guild, value);
    if (!channel) {
      throw dashboardError('Selected channel no longer exists.', 'That channel could not be found. Choose another channel.');
    }

    assertTextDestinationPermissions(guild, channel, {
      transcript: field === 'ticketTranscriptChannelId',
    });
    return channel.id;
  }

  if (field === 'ticketCategoryId' || field === 'ticketClosedCategoryId') {
    const channel = await fetchGuildChannel(guild, value);
    if (!channel || channel.type !== ChannelType.GuildCategory) {
      throw dashboardError('Selected category is invalid.', 'Choose a valid Discord category.');
    }
    return channel.id;
  }

  if (field === 'ticketStaffRoleId') {
    const role = await fetchGuildRole(guild, value);
    if (!role || role.id === guild.id || role.managed) {
      throw dashboardError('Selected staff role is invalid.', 'Choose a normal server role that Cloudy can use for ticket staff.');
    }
    return role.id;
  }

  return value;
}

export async function findTicketPanelMessage(client, guild, config) {
  if (!config?.ticketPanelChannelId) return null;

  const channel = await fetchGuildChannel(guild, config.ticketPanelChannelId);
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
  const validatedChannelId = await validateTicketDashboardValue(
    client,
    guild,
    'ticketPanelChannelId',
    newChannelId,
  );
  const newChannel = await fetchGuildChannel(guild, validatedChannelId);

  const oldPanel = await findTicketPanelMessage(client, guild, config);
  const sent = await newChannel.send(buildTicketPanelPayload(client, config));

  let saved;
  try {
    saved = await updateGuildConfig(client, guild.id, {
      ticketPanelChannelId: validatedChannelId,
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
    throw dashboardError('Ticket panel channel is not configured.', 'Choose a panel channel first.');
  }

  const channelId = await validateTicketDashboardValue(
    client,
    guild,
    'ticketPanelChannelId',
    config.ticketPanelChannelId,
  );
  const channel = await fetchGuildChannel(guild, channelId);
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
    throw dashboardError(`Unsupported ticket dashboard field: ${field}`, 'That ticket setting cannot be changed.');
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
      new StringSelectMenuOptionBuilder().setLabel('Change Panel Channel').setDescription('Choose from all available text channels').setValue('panel_channel').setEmoji('💬'),
      new StringSelectMenuOptionBuilder().setLabel('Change Open Tickets Category').setDescription('Choose from all server categories').setValue('open_category').setEmoji('📁'),
      new StringSelectMenuOptionBuilder().setLabel('Change Closed Tickets Category').setDescription('Choose from all server categories').setValue('closed_category').setEmoji('📂'),
      new StringSelectMenuOptionBuilder().setLabel('Set Max Tickets per User').setDescription('Limit open tickets per member').setValue('max_tickets').setEmoji('🔢'),
      new StringSelectMenuOptionBuilder().setLabel('Set Ticket Logs Channel').setDescription('Choose any visible text channel, including private').setValue('logs_channel').setEmoji('🎫'),
      new StringSelectMenuOptionBuilder().setLabel('Set Transcript Channel').setDescription('Choose any visible text channel, including private').setValue('transcript_channel').setEmoji('📜'),
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
    .setDescription(
      `Manage the ticket system for **${guild.name}**. Changes are saved persistently as soon as you confirm them.\n\n` +
      'Channel and role settings use Discord\'s native selectors, so they are no longer limited to 24 options.'
    )
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

function buildNumberSelect(guildId, definition, config) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket_dashboard_value:${guildId}:${definition.field}`)
    .setPlaceholder(`Choose ${definition.title.toLowerCase()}...`)
    .setMinValues(1)
    .setMaxValues(1);

  for (let value = 1; value <= 10; value += 1) {
    select.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(`${value} ticket${value === 1 ? '' : 's'}`)
        .setValue(String(value))
        .setDefault(Number(config.maxTicketsPerUser ?? 3) === value),
    );
  }

  return select;
}

function buildNativeValueSelect(guild, definition, config) {
  const customId = `ticket_dashboard_value:${guild.id}:${definition.field}`;

  if (definition.type === 'number') {
    return buildNumberSelect(guild.id, definition, config);
  }

  if (definition.type === 'role') {
    return new RoleSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose any server role...')
      .setMinValues(1)
      .setMaxValues(1);
  }

  const channelTypes = definition.type === 'category'
    ? [ChannelType.GuildCategory]
    : [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  return new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(
      definition.type === 'category'
        ? 'Choose any server category...'
        : 'Choose any text channel, including private channels...'
    )
    .setChannelTypes(...channelTypes)
    .setMinValues(1)
    .setMaxValues(1);
}

export function getTicketDashboardSettingDefinition(setting) {
  return SETTING_DEFINITIONS[setting] || null;
}

export function buildTicketDashboardValuePrompt(guild, setting, config) {
  const definition = getTicketDashboardSettingDefinition(setting);
  if (!definition) return null;

  const select = buildNativeValueSelect(guild, definition, config);
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ticket_dashboard_back:${guild.id}`)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('↩️'),
  ];

  if (NULLABLE_FIELDS.has(definition.field)) {
    buttons.unshift(
      new ButtonBuilder()
        .setCustomId(`ticket_dashboard_clear:${guild.id}:${definition.field}`)
        .setLabel('Clear setting')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✖️'),
    );
  }

  const currentValue = config[definition.field]
    ? (definition.type === 'role' ? `<@&${config[definition.field]}>` : `<#${config[definition.field]}>`)
    : '`Not set`';

  const embed = new EmbedBuilder()
    .setTitle(definition.title)
    .setDescription(
      `${definition.description}\n\n**Current:** ${definition.type === 'number' ? String(config.maxTicketsPerUser ?? 3) : currentValue}` +
      (definition.type === 'text_channel' ? '\n\nPrivate channels are supported. Cloudy will verify its permissions when you select one.' : '')
    )
    .setColor(getColor('info'));

  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(...buttons),
    ],
  };
}

export async function getCurrentTicketDashboardConfig(client, guildId) {
  return await getGuildConfig(client, guildId);
}
