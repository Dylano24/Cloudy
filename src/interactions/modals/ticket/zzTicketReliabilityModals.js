import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../../utils/embeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import {
  closeTicket,
  createTicket,
} from '../../../services/ticketReliabilityService.js';
import { logger } from '../../../utils/logger.js';

const createTicketModal = {
  name: 'create_ticket_modal',

  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;

      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;

      const { channel } = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason,
      );

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Created', `Your ticket has been created in ${channel}!`)],
      });
    } catch (error) {
      if (error?.userMessage && (interaction.deferred || interaction.replied)) {
        await InteractionHelper.safeEditReply(interaction, {
          content: error.userMessage,
          embeds: [],
          components: [],
        }).catch(() => {});
        return;
      }

      await handleInteractionError(interaction, error, {
        type: 'modal',
        handler: 'ticket_reliability',
        customId: interaction.customId,
      });
    }
  },
};

const closeTicketModal = {
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
      logger.error('Reliable ticket close modal failed', {
        error: error.message,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'An error occurred while closing the ticket. Please try again.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};

export default [createTicketModal, closeTicketModal];
