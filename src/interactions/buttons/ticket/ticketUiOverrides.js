import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import {
  claimTicket,
  unclaimTicket,
  reopenTicket,
} from '../../../services/ticketUiService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';
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
      logger.error('Ticket claim button failed', { error: error.message, channelId: interaction.channelId });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'An error occurred while claiming the ticket.',
      });
    }
  },
};

const priorityMenuHandler = {
  name: 'ticket_priority_menu',
  async execute(interaction, client) {
    // Acknowledge Discord immediately so a slower database lookup can never expire the button interaction.
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
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
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
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
    }
  },
};

export default [
  claimTicketHandler,
  priorityMenuHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
];
