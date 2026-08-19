import { successEmbed } from '../../../utils/embeds.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { updateTicketPriority } from '../../../services/ticketUiService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';
import { logger } from '../../../utils/logger.js';

const VALID_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none']);

export default {
  name: 'ticket_priority_select',

  async execute(interaction, client) {
    // Acknowledge the select immediately. This prevents Discord's interaction timeout
    // even when PostgreSQL or permission checks take a moment.
    try {
      await interaction.deferUpdate();
    } catch (error) {
      logger.warn('Could not acknowledge ticket priority select', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      return;
    }

    try {
      const priority = interaction.values?.[0];
      if (!VALID_PRIORITIES.has(priority)) {
        await interaction.editReply({
          content: 'Invalid priority selected.',
          embeds: [],
          components: [],
        });
        return;
      }

      const context = await getTicketPermissionContext({ client, interaction });
      if (!context.ticketData) {
        await interaction.editReply({
          content: 'This action can only be used in a valid ticket channel.',
          embeds: [],
          components: [],
        });
        return;
      }

      if (!context.canManageTicket) {
        await interaction.editReply({
          content: 'Only admins or the configured Ticket Staff Role can change ticket priority.',
          embeds: [],
          components: [],
        });
        return;
      }

      const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
      const currentPriority = String(context.ticketData.priority || 'none').toLowerCase();

      if (currentPriority !== priority) {
        await updateTicketPriority(interaction.channel, priority, interaction.user);
      }

      await interaction.editReply({
        content: '',
        embeds: [successEmbed(
          'Priority Updated',
          currentPriority === priority
            ? `Ticket priority is already set to **${priorityInfo.emoji} ${priorityInfo.label}**.`
            : `Ticket priority has been set to **${priorityInfo.emoji} ${priorityInfo.label}**.`,
        )],
        components: [],
      });
    } catch (error) {
      logger.error('Ticket priority select failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await interaction.editReply({
        content: 'An error occurred while updating the ticket priority. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
