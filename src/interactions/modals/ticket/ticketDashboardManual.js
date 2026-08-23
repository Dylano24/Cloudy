import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  getCurrentTicketDashboardConfig,
  moveTicketPanel,
  saveTicketDashboardSetting,
  validateTicketDashboardValue,
} from '../../../services/ticketDashboardService.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import {
  buildCloudyTicketEmbed,
  scheduleTicketReplyDeletion,
} from '../../../utils/ticket/ticketBranding.js';
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

async function refreshDashboardMessage(interaction, dashboardMessageId, config) {
  if (!dashboardMessageId) return false;
  const channel = interaction.channel;
  if (!channel?.messages?.fetch) return false;

  const dashboardMessage = await channel.messages.fetch(dashboardMessageId).catch(() => null);
  if (!dashboardMessage?.edit) return false;

  await dashboardMessage.edit(buildTicketDashboardPayload(interaction.guild, config));
  return true;
}

export default {
  name: 'ticket_dashboard_manual_modal',

  async execute(interaction, client, args = []) {
    const [guildId, field, dashboardMessageId] = args;
    if (!interaction.inGuild() || guildId !== interaction.guildId) return;

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
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

    try {
      await interaction.reply({
        content: 'Saving ticket setting…',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Manual ticket dashboard modal could not be acknowledged', {
        guildId,
        field,
        error: error.message,
      });
      return;
    }

    try {
      const rawValue = interaction.fields.getTextInputValue('value');
      const id = extractDiscordId(rawValue);
      if (!id) {
        const error = new Error('No valid Discord ID was provided.');
        error.userMessage = 'Enter a valid channel/role mention or Discord ID.';
        throw error;
      }

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

      await refreshDashboardMessage(interaction, dashboardMessageId, savedConfig).catch(error => {
        logger.warn('Manual ticket dashboard source message refresh failed', {
          guildId,
          field,
          dashboardMessageId,
          error: error.message,
        });
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [buildCloudyTicketEmbed({
          title: 'Ticket Setting Updated',
          description: 'Ticket setting saved.',
        })],
        components: [],
      });
      scheduleTicketReplyDeletion(interaction);
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
