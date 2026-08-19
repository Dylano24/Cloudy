import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { updateTicketPriority } from '../../../services/ticketUiService.js';
import { logger } from '../../../utils/logger.js';

const VALID_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none']);

export default {
  name: 'ticket_priority_select',

  async execute(interaction, client) {
    try {
      const context = await getTicketPermissionContext({ client, interaction });
      if (!context.ticketData) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'This action can only be used in a valid ticket channel.',
        });
      }

      if (!context.canManageTicket) {
        return await replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: 'Only admins or the configured Ticket Staff Role can change ticket priority.',
        });
      }

      const priority = interaction.values?.[0];
      if (!VALID_PRIORITIES.has(priority)) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Invalid priority selected.',
        });
      }

      await interaction.deferUpdate();
      await updateTicketPriority(interaction.channel, priority, interaction.user);
      await interaction.followUp({
        embeds: [successEmbed('Priority Updated', `Ticket priority set to **${priority.toUpperCase()}**.`)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error('Ticket priority select failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'An error occurred while updating the ticket priority.',
        });
      }
    }
  },
};
