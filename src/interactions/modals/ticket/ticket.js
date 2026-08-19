import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { closeTicket } from '../../../services/ticketUiService.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'ticket_close_modal',

  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await getTicketPermissionContext({ client, interaction });

      if (!context.ticketData) {
        await InteractionHelper.safeEditReply(interaction, {
          content: 'This action can only be used in a valid ticket channel.',
          embeds: [],
          components: [],
        });
        return;
      }

      if (!context.canCloseTicket) {
        await InteractionHelper.safeEditReply(interaction, {
          content: 'Only the ticket creator, admins, or the configured Ticket Staff Role can close this ticket.',
          embeds: [],
          components: [],
        });
        return;
      }

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'No reason provided.';

      await closeTicket(interaction.channel, interaction.user, reason);
      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')],
        components: [],
      });
    } catch (error) {
      logger.error('Ticket close modal failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: 'An error occurred while closing the ticket. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};
