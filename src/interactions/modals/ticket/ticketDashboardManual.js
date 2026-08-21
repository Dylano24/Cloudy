import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  getCurrentTicketDashboardConfig,
  moveTicketPanel,
  saveTicketDashboardSetting,
  validateTicketDashboardValue,
} from '../../../services/ticketDashboardService.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
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

function extractDiscordId(value) {
  const match = String(value || '').match(/\d{17,20}/);
  return match?.[0] || null;
}

export default {
  name: 'ticket_dashboard_manual_modal',

  async execute(interaction, client, args = []) {
    const [guildId, field] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    if (!interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      await InteractionHelper.safeReply(interaction, {
        content: 'You need the `Manage Channels` permission to change ticket-system settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!MANUAL_FIELDS.has(field)) {
      await InteractionHelper.safeReply(interaction, {
        content: 'That ticket setting cannot be entered manually.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const rawValue = interaction.fields.getTextInputValue('value');
      const id = extractDiscordId(rawValue);
      if (!id) {
        const error = new Error('No valid Discord ID was provided.');
        error.userMessage = 'Enter a valid channel/role mention or Discord ID.';
        throw error;
      }

      // The validator fetches only the exact requested channel/role if needed.
      // Never refresh the entire server for one pasted Discord ID.
      const validated = await validateTicketDashboardValue(
        client,
        interaction.guild,
        field,
        id,
      );

      let savedConfig;
      if (field === 'ticketPanelChannelId') {
        savedConfig = await moveTicketPanel(client, interaction.guild, validated);
      } else {
        savedConfig = await saveTicketDashboardSetting(
          client,
          interaction.guild,
          field,
          validated,
        );
      }

      await InteractionHelper.safeEditReply(interaction, {
        content: '✅ Ticket setting saved.',
        embeds: [],
        components: [],
      });

      if (interaction.message?.edit) {
        await interaction.message.edit(
          buildTicketDashboardPayload(interaction.guild, savedConfig),
        ).catch(() => {});
      }
    } catch (error) {
      logger.error('Manual ticket dashboard value save failed', {
        guildId,
        field,
        userId: interaction.user?.id,
        error: error.message,
      });

      const config = await getCurrentTicketDashboardConfig(client, guildId).catch(() => ({}));
      const payload = buildTicketDashboardPayload(interaction.guild, config);
      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'Could not save that ticket setting. Please try again.',
        embeds: payload.embeds,
        components: payload.components,
      }).catch(() => {});
    }
  },
};
