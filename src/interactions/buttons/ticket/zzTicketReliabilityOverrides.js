import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import {
  claimTicket,
  deleteTicket,
  reopenTicket,
  toggleTicketPinned,
  unclaimTicket,
} from '../../../services/ticketReliabilityService.js';
import { logTicketEvent } from '../../../utils/ticket/ticketLogging.js';
import { logger } from '../../../utils/logger.js';

async function requireStaff(interaction, client, action) {
  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await replyUserError(interaction, {
      type: ErrorTypes.VALIDATION,
      message: 'This action can only be used in a valid ticket channel.',
    });
    return null;
  }

  if (!context.canManageTicket) {
    await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: `Only admins or the configured Ticket Staff Role can ${action}.`,
    });
    return null;
  }

  return context;
}

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'claim tickets');
      if (!context) return;

      await claimTicket(interaction.channel, interaction.user);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Claimed', 'You have claimed this ticket.')],
      });
    } catch (error) {
      logger.error('Reliable ticket claim button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while claiming the ticket.',
      });
    }
  },
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'pin tickets');
      if (!context) return;

      const willBePinned = await toggleTicketPinned(interaction.channel);

      interaction.channel.setPosition(willBePinned ? 0 : 999).catch(error => {
        logger.warn('Could not update ticket channel position', {
          channelId: interaction.channelId,
          error: error.message,
        });
      });

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed(
          willBePinned ? 'Ticket Pinned' : 'Ticket Unpinned',
          willBePinned
            ? 'This ticket has been pinned to the top of the category.'
            : 'This ticket has been moved back to its normal position.',
        )],
      });

      void logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: willBePinned ? 'pin' : 'unpin',
          ticketId: interaction.channelId,
          ticketNumber: context.ticketData.ticketNumber || context.ticketData.id,
          userId: context.ticketData.userId,
          executorId: interaction.user.id,
          metadata: { isPinned: willBePinned },
        },
      }).catch(() => {});
    } catch (error) {
      logger.error('Reliable ticket pin button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'Failed to pin or unpin the ticket.',
      });
    }
  },
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'unclaim tickets');
      if (!context) return;

      await unclaimTicket(interaction.channel, interaction.member);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Unclaimed', 'This ticket has been unclaimed.')],
      });
    } catch (error) {
      logger.error('Reliable ticket unclaim button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while unclaiming the ticket.',
      });
    }
  },
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'reopen tickets');
      if (!context) return;

      const result = await reopenTicket(interaction.channel, interaction.member);
      const note = result?.openCategoryMoveFailed
        ? ' The ticket was reopened, but the channel could not be moved back to the open category yet. Cloudy will retry automatically.'
        : '';

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Reopened', `This ticket has been reopened.${note}`)],
      });
    } catch (error) {
      logger.error('Reliable ticket reopen button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while reopening the ticket.',
      });
    }
  },
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'delete tickets');
      if (!context) return;

      await deleteTicket(interaction.channel, interaction.user);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Deleted', 'This ticket will be deleted shortly.')],
      });
    } catch (error) {
      logger.error('Reliable ticket delete button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while deleting the ticket.',
      });
    }
  },
};

export default [
  claimTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
];
