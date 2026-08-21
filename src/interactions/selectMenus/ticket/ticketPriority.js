import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { updateTicketPriority } from '../../../services/ticketReliabilityService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';
import {
  buildCloudyTicketEmbed,
  scheduleTicketReplyDeletion,
} from '../../../utils/ticket/ticketBranding.js';
import { logger } from '../../../utils/logger.js';

const VALID_PRIORITIES = new Set(['high', 'medium', 'low', 'none']);

export default {
  name: 'ticket_priority_select',

  async execute(interaction, client) {
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
      const storedPriority = String(context.ticketData.priority || 'none').toLowerCase();
      const currentPriority = storedPriority === 'urgent' ? 'high' : storedPriority;

      await updateTicketPriority(interaction.channel, priority, interaction.user);

      await interaction.editReply({
        content: '',
        embeds: [buildCloudyTicketEmbed({
          title: 'Priority Updated',
          description: currentPriority === priority
            ? `Ticket priority remains **${priorityInfo.emoji} ${priorityInfo.label}**.`
            : `Ticket priority has been set to **${priorityInfo.emoji} ${priorityInfo.label}**.`,
        })],
        components: [],
      });
      scheduleTicketReplyDeletion(interaction);
    } catch (error) {
      logger.error('Ticket priority select failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await interaction.editReply({
        content: error?.userMessage || 'An error occurred while updating the ticket priority. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
