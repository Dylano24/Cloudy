import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import {
  claimTicket,
  unclaimTicket,
  reopenTicket,
  deleteTicket,
  setTicketPinned,
} from '../../../services/ticketUiService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';
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

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Tickets can only be created inside a server.',
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Create a Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('How can we help you?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe your request or issue...')
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Create ticket button failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Could not open the ticket form. Please try again.',
        });
      }
    }
  },
};

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
      logger.error('Ticket claim button failed', { error: error.message, channelId: interaction.channelId });
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

      const channel = interaction.channel;
      const wasPinned = String(channel.name || '').includes('📌');
      const willBePinned = !wasPinned;

      // Pin and Priority share one channel-name queue. This prevents them from
      // overwriting each other or getting stuck behind Discord rename limits.
      await setTicketPinned(channel, willBePinned);

      // Position updates are independent from the channel-name status queue.
      channel.setPosition(willBePinned ? 0 : 999).catch(error => {
        logger.warn('Could not update ticket channel position', {
          channelId: channel.id,
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

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: willBePinned ? 'pin' : 'unpin',
          ticketId: channel.id,
          ticketNumber: String(channel.name || '').replace(/[^0-9]/g, ''),
          userId: context.ticketData.userId,
          executorId: interaction.user.id,
          metadata: { isPinned: willBePinned },
        },
      }).catch(() => {});
    } catch (error) {
      logger.error('Ticket pin button failed', { error: error.message, channelId: interaction.channelId });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'Failed to pin or unpin the ticket.',
      });
    }
  },
};

const priorityMenuHandler = {
  name: 'ticket_priority_menu',
  async execute(interaction, client) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'change ticket priority');
      if (!context) return;

      const currentPriority = String(context.ticketData.priority || 'none').toLowerCase();
      const currentInfo = PRIORITY_MAP[currentPriority] || PRIORITY_MAP.none;

      const menu = new StringSelectMenuBuilder()
        .setCustomId('ticket_priority_select')
        .setPlaceholder('Select a new priority...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Urgent').setValue('urgent').setEmoji('🚨'),
          new StringSelectMenuOptionBuilder().setLabel('High').setValue('high').setEmoji('🔴'),
          new StringSelectMenuOptionBuilder().setLabel('Medium').setValue('medium').setEmoji('🟡'),
          new StringSelectMenuOptionBuilder().setLabel('Low').setValue('low').setEmoji('🟢'),
          new StringSelectMenuOptionBuilder().setLabel('None').setValue('none').setEmoji('⚪'),
        );

      await InteractionHelper.safeEditReply(interaction, {
        content: `Current priority: **${currentInfo.emoji} ${currentInfo.label}**\nSelect a new priority below.`,
        embeds: [],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    } catch (error) {
      logger.error('Priority menu button failed', { error: error.message, channelId: interaction.channelId });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'Could not open the priority menu.',
      });
    }
  },
};

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction) {
    try {
      if (!interaction.inGuild()) return;

      // Permission is checked again when the modal is submitted. Showing the
      // modal immediately avoids Discord's three-second interaction timeout.
      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Close Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for closing (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Add an optional reason for closing this ticket...')
        .setRequired(false)
        .setMaxLength(1000);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Ticket close button failed', { error: error.message, channelId: interaction.channelId });
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'Could not open the ticket close form. Please try again.',
        });
      }
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
      logger.error('Ticket unclaim button failed', { error: error.message, channelId: interaction.channelId });
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
      const note = result.openCategoryMoveFailed
        ? ' The ticket was reopened, but the channel could not be moved back to the open category.'
        : '';

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Reopened', `This ticket has been reopened.${note}`)],
      });
    } catch (error) {
      logger.error('Ticket reopen button failed', { error: error.message, channelId: interaction.channelId });
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
      logger.error('Ticket delete button failed', { error: error.message, channelId: interaction.channelId });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while deleting the ticket.',
      });
    }
  },
};

export default [
  createTicketHandler,
  claimTicketHandler,
  pinTicketHandler,
  priorityMenuHandler,
  closeTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
];
