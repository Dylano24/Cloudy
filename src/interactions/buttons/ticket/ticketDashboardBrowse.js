import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildTicketDashboardValuePrompt,
  getCurrentTicketDashboardConfig,
  refreshTicketDashboardCache,
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
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';

const MANUAL_FIELDS = new Set([
  'ticketPanelChannelId',
  'ticketCategoryId',
  'ticketClosedCategoryId',
  'ticketStaffRoleId',
  'ticketLogsChannelId',
  'ticketTranscriptChannelId',
]);

function canManageTickets(interaction) {
  return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
}

async function rejectUnauthorized(interaction) {
  const payload = {
    content: 'You need the `Manage Channels` permission to change ticket-system settings.',
    flags: MessageFlags.Ephemeral,
  };

  if (interaction.deferred || interaction.replied) {
    await InteractionHelper.safeEditReply(interaction, payload);
  } else {
    await InteractionHelper.safeReply(interaction, payload);
  }
}

const pageHandler = {
  name: 'ticket_dashboard_page',

  async execute(interaction, client, args = []) {
    const [guildId, setting, pageRaw] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;
    if (!canManageTickets(interaction)) return rejectUnauthorized(interaction);

    try {
      await interaction.deferUpdate();

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const page = Math.max(0, Number.parseInt(pageRaw, 10) || 0);
      const payload = isAllChannelTicketSetting(setting)
        ? buildAllChannelTicketPrompt(interaction.guild, setting, config, page)
        : buildTicketDashboardValuePrompt(interaction.guild, setting, config, page);

      await interaction.editReply(
        brandTicketDashboardPayload(payload || buildTicketDashboardPayload(interaction.guild, config)),
      );

      if (isAllChannelTicketSetting(setting)) {
        void refreshAllTicketChannels(interaction.guild).catch(() => {});
      } else {
        void refreshTicketDashboardCache(interaction.guild).catch(() => {});
      }
    } catch (error) {
      logger.error('Ticket dashboard pagination failed', {
        guildId,
        setting,
        pageRaw,
        error: error.message,
      });

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      payload.content = error?.userMessage || 'Could not load that page. Please try again.';
      await interaction.editReply(payload).catch(() => {});
    }
  },
};

const manualHandler = {
  name: 'ticket_dashboard_manual',

  async execute(interaction, _client, args = []) {
    const [guildId, field] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;
    if (!canManageTickets(interaction)) return rejectUnauthorized(interaction);

    if (!MANUAL_FIELDS.has(field)) {
      await InteractionHelper.safeReply(interaction, {
        content: 'That ticket setting cannot be entered manually.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isRole = field === 'ticketStaffRoleId';
    const isCategory = field === 'ticketCategoryId' || field === 'ticketClosedCategoryId';
    const label = isRole
      ? 'Role mention or ID'
      : isCategory
        ? 'Category ID'
        : 'Channel mention or ID';

    const input = new TextInputBuilder()
      .setCustomId('value')
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(17)
      .setMaxLength(30)
      .setPlaceholder(isRole ? '123456789012345678' : '<#123456789012345678>');

    const modal = new ModalBuilder()
      .setCustomId(`ticket_dashboard_manual_modal:${guildId}:${field}`)
      .setTitle(isRole ? 'Set role by ID' : isCategory ? 'Set category by ID' : 'Set channel by ID')
      .addComponents(new ActionRowBuilder().addComponents(input));

    await interaction.showModal(modal);
  },
};

export default [pageHandler, manualHandler];
