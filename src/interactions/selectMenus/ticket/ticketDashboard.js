import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  TICKET_DASHBOARD_CLEAR_VALUE,
  buildTicketDashboardValuePrompt,
  getCurrentTicketDashboardConfig,
  moveTicketPanel,
  refreshTicketDashboardCache,
  saveTicketDashboardSetting,
  validateTicketDashboardValue,
} from '../../../services/ticketDashboardService.js';
import {
  brandTicketDashboardPayload,
  buildTicketDashboardPayload,
} from '../../../services/ticketDashboardViewService.js';
import {
  buildAllChannelTicketPrompt,
  isAllChannelTicketSetting,
  refreshAllTicketChannels,
} from '../../../services/ticketChannelBrowserService.js';
import { peekGuildConfigCache } from '../../../services/config/guildConfig.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const FIELD_TO_SETTING = new Map([
  ['ticketPanelChannelId', 'panel_channel'],
  ['ticketCategoryId', 'open_category'],
  ['ticketClosedCategoryId', 'closed_category'],
  ['ticketStaffRoleId', 'staff_role'],
  ['maxTicketsPerUser', 'max_tickets'],
  ['ticketLogsChannelId', 'logs_channel'],
  ['ticketTranscriptChannelId', 'transcript_channel'],
]);

const CONFIG_READ_TIMEOUT_MS = 250;

function canManageTickets(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels));
}

async function rejectUnauthorized(interaction) {
  const payload = {
    content: 'You need the `Manage Channels` permission to change ticket-system settings.',
    embeds: [],
    components: [],
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    await InteractionHelper.safeEditReply(interaction, payload);
  } else {
    await InteractionHelper.safeReply(interaction, payload);
  }
}

async function readConfigFast(client, guildId) {
  const cached = peekGuildConfigCache(guildId);
  if (cached) return cached;

  let timer;
  try {
    return await Promise.race([
      getCurrentTicketDashboardConfig(client, guildId).catch(() => ({})),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({}), CONFIG_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getDashboardFieldValue(interaction, fieldName) {
  const field = interaction.message?.embeds?.[0]?.fields?.find(item => item.name === fieldName);
  if (!field?.value) return '';
  const value = String(field.value);
  if (value === '`Not set`') return '';
  if (value.startsWith('`') && value.endsWith('`')) return value.slice(1, -1);
  return '';
}

function buildTextSettingModal(interaction, guildId, setting) {
  const isPanelMessage = setting === 'panel_message';
  const field = isPanelMessage ? 'ticketPanelMessage' : 'ticketButtonLabel';
  const modal = new ModalBuilder()
    .setCustomId(`ticket_dashboard_modal:${guildId}:${field}:${interaction.message.id}`)
    .setTitle(isPanelMessage ? 'Edit Panel Message' : 'Edit Button Label');

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(isPanelMessage ? 'Panel message' : 'Button label')
    .setStyle(isPanelMessage ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(isPanelMessage ? 2000 : 80);

  if (!isPanelMessage) {
    const currentButtonLabel = getDashboardFieldValue(interaction, 'Button Label');
    if (currentButtonLabel) input.setValue(currentButtonLabel.slice(0, 80));
  }

  if (isPanelMessage) input.setPlaceholder('Enter the exact support panel message...');
  else input.setPlaceholder('Start Chat');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function validateDashboardContext(interaction, guildId) {
  if (!interaction.inGuild() || guildId !== interaction.guildId) {
    await InteractionHelper.safeReply(interaction, {
      content: 'This ticket dashboard is outdated. Run `/ticket dashboard` again.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (!canManageTickets(interaction)) {
    await rejectUnauthorized(interaction);
    return false;
  }

  return true;
}

function optimisticValue(field, rawValue) {
  if (field === 'maxTicketsPerUser') return Number.parseInt(rawValue, 10);
  if (rawValue === TICKET_DASHBOARD_CLEAR_VALUE) return null;
  return rawValue;
}

async function persistDashboardValue(interaction, client, guildId, field, rawValue, previousConfig) {
  try {
    let savedConfig;

    if (field === 'ticketPanelChannelId') {
      if (rawValue === TICKET_DASHBOARD_CLEAR_VALUE) {
        const error = new Error('Panel channel cannot be cleared while the ticket system is active.');
        error.userMessage = 'Choose another panel channel, or use **Delete System** if you want to remove the ticket system.';
        throw error;
      }

      const channelId = await validateTicketDashboardValue(client, interaction.guild, field, rawValue);
      savedConfig = await moveTicketPanel(client, interaction.guild, channelId);
    } else if (field === 'maxTicketsPerUser') {
      const value = Number.parseInt(rawValue, 10);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        const error = new Error('Invalid max tickets value.');
        error.userMessage = 'Choose a maximum between **1 and 10 tickets per user**.';
        throw error;
      }
      savedConfig = await saveTicketDashboardSetting(client, interaction.guild, field, value);
    } else {
      const value = rawValue === TICKET_DASHBOARD_CLEAR_VALUE ? null : rawValue;
      const validatedValue = await validateTicketDashboardValue(client, interaction.guild, field, value);
      savedConfig = await saveTicketDashboardSetting(client, interaction.guild, field, validatedValue);
    }

    await interaction.editReply(buildTicketDashboardPayload(interaction.guild, savedConfig)).catch(() => {});
  } catch (error) {
    logger.error('Background ticket dashboard value save failed', {
      guildId,
      field,
      userId: interaction.user?.id,
      error: error.message,
      stack: error.stack,
    });

    if (previousConfig) {
      await interaction.editReply(buildTicketDashboardPayload(interaction.guild, previousConfig)).catch(() => {});
    }

    await interaction.followUp({
      content: error?.userMessage || 'Could not save that ticket setting. Please try again.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }
}

const dashboardSelectHandler = {
  name: 'ticket_dashboard_select',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!(await validateDashboardContext(interaction, guildId))) return;

    const setting = interaction.values?.[0];
    logger.info('Ticket dashboard setting selected', {
      guildId,
      setting,
      userId: interaction.user?.id,
    });

    try {
      if (setting === 'panel_message' || setting === 'button_label') {
        if (interaction.deferred || interaction.replied) {
          throw new Error('Ticket dashboard text interaction was acknowledged before the modal could open.');
        }

        await interaction.showModal(buildTextSettingModal(interaction, guildId, setting));
        return;
      }

      const freshConfig = await readConfigFast(client, guildId);
      const prompt = isAllChannelTicketSetting(setting)
        ? buildAllChannelTicketPrompt(interaction.guild, setting, freshConfig, 0)
        : buildTicketDashboardValuePrompt(interaction.guild, setting, freshConfig, 0);

      const payload = brandTicketDashboardPayload(
        prompt || buildTicketDashboardPayload(interaction.guild, freshConfig),
      );

      await interaction.update(payload);

      if (isAllChannelTicketSetting(setting)) {
        void refreshAllTicketChannels(interaction.guild).catch(() => {});
      } else if (setting === 'open_category' || setting === 'closed_category' || setting === 'staff_role') {
        void refreshTicketDashboardCache(interaction.guild).catch(() => {});
      }
    } catch (error) {
      logger.error('Persistent ticket dashboard select failed', {
        guildId,
        setting,
        userId: interaction.user?.id,
        error: error.message,
        stack: error.stack,
      });

      const config = await readConfigFast(client, guildId);
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || `Could not open ${setting || 'that ticket setting'}. Please try again.`;

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await InteractionHelper.safeReply(interaction, {
          content: payload.content,
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

const dashboardValueHandler = {
  name: 'ticket_dashboard_value',

  async execute(interaction, client, args = []) {
    const [guildId, field, settingArg] = args;
    if (!(await validateDashboardContext(interaction, guildId))) return;

    const setting = settingArg || FIELD_TO_SETTING.get(field) || null;
    const rawValue = interaction.values?.[0];

    if (!rawValue) {
      await InteractionHelper.safeReply(interaction, {
        content: 'No ticket dashboard value was selected.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const previousConfig = await readConfigFast(client, guildId);
    const optimisticConfig = {
      ...previousConfig,
      [field]: optimisticValue(field, rawValue),
      dmOnClose: false,
    };

    try {
      // Return to the dashboard immediately. Persistence, Discord permission
      // validation and panel movement happen afterwards in the background.
      await interaction.update(buildTicketDashboardPayload(interaction.guild, optimisticConfig));
    } catch (error) {
      logger.error('Ticket dashboard optimistic value update failed', {
        guildId,
        field,
        setting,
        error: error.message,
      });
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
    }

    void persistDashboardValue(interaction, client, guildId, field, rawValue, previousConfig);
  },
};

export default [dashboardSelectHandler, dashboardValueHandler];
