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
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import {
  buildAllChannelTicketPrompt,
  isAllChannelTicketSetting,
  refreshAllTicketChannels,
} from '../../../services/ticketChannelBrowserService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

function canManageTickets(interaction) {
  return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
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

const dashboardSelectHandler = {
  name: 'ticket_dashboard_select',

  async execute(interaction, client, args = []) {
    const guildId = args[0];
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;
    if (!canManageTickets(interaction)) return rejectUnauthorized(interaction);

    const setting = interaction.values?.[0];

    try {
      if (setting === 'panel_message' || setting === 'button_label') {
        await interaction.showModal(buildTextSettingModal(interaction, guildId, setting));
        return;
      }

      // Discord interaction first, work second. No REST refresh is allowed to
      // hold the component in a loading state.
      await interaction.deferUpdate();

      const freshConfig = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const prompt = isAllChannelTicketSetting(setting)
        ? buildAllChannelTicketPrompt(interaction.guild, setting, freshConfig, 0)
        : buildTicketDashboardValuePrompt(interaction.guild, setting, freshConfig, 0);

      await interaction.editReply(prompt || buildTicketDashboardPayload(interaction.guild, freshConfig));

      // Refresh inventory only after the response is visible. The normal guild
      // cache already contains the current server structure in the common case.
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

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
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
    const [guildId, field, setting, pageRaw] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;
    if (!canManageTickets(interaction)) return rejectUnauthorized(interaction);

    try {
      await interaction.deferUpdate();

      const rawValue = interaction.values?.[0];
      if (!rawValue) throw new Error('No ticket dashboard value was selected.');

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

      await interaction.editReply(buildTicketDashboardPayload(interaction.guild, savedConfig));
    } catch (error) {
      logger.error('Persistent ticket dashboard value save failed', {
        guildId,
        field,
        setting,
        userId: interaction.user?.id,
        error: error.message,
        stack: error.stack,
      });

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      let payload;

      if (isAllChannelTicketSetting(setting)) {
        const page = Math.max(0, Number.parseInt(pageRaw, 10) || 0);
        payload = buildAllChannelTicketPrompt(interaction.guild, setting, config, page)
          || buildTicketDashboardPayload(interaction.guild, config);
      } else if (field === 'maxTicketsPerUser') {
        payload = buildTicketDashboardValuePrompt(interaction.guild, 'max_tickets', config, 0)
          || buildTicketDashboardPayload(interaction.guild, config);
      } else {
        payload = buildTicketDashboardPayload(interaction.guild, config);
      }

      payload.content = error?.userMessage || 'Could not save that ticket setting. Please try again.';

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

export default [dashboardSelectHandler, dashboardValueHandler];
