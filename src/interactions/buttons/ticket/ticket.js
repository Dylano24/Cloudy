import { MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { updateTicketPriority } from '../../../services/ticketUiService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';

const legacyPriorityHandler = {
  name: 'ticket_priority',

  async execute(interaction, client, args = []) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    const context = await getTicketPermissionContext({ client, interaction });
    if (!context.ticketData) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'This action can only be used in a valid ticket channel.',
        embeds: [],
        components: [],
      });
      return;
    }

    if (!context.canManageTicket) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'Only admins or the configured Ticket Staff Role can change ticket priority.',
        embeds: [],
        components: [],
      });
      return;
    }

    const priority = String(args[0] || '').toLowerCase();
    const info = PRIORITY_MAP[priority];
    if (!info) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'Invalid priority selected.',
        embeds: [],
        components: [],
      });
      return;
    }

    try {
      await updateTicketPriority(interaction.channel, priority, interaction.user);
      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [successEmbed('Priority Updated', `Ticket priority has been set to **${info.emoji} ${info.label}**.`)],
        components: [],
      });
    } catch (error) {
      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'An error occurred while updating the ticket priority.',
        embeds: [],
        components: [],
      });
    }
  },
};

export default [legacyPriorityHandler];
