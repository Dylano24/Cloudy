import { MessageFlags, PermissionFlagsBits } from 'discord.js';
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

async function ensureTicketCreatorAccess(channel, userId) {
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
  ];

  const member = await channel.guild.members.fetch(userId).catch(() => null);
  const permissions = member ? channel.permissionsFor(member) : null;

  if (permissions?.has(requiredPermissions)) {
    return true;
  }

  try {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    }, {
      reason: 'Ensure ticket creator can access newly created ticket',
    });
    return true;
  } catch (error) {
    logger.warn('Could not repair ticket creator permissions', {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId,
      error: error.message,
    });
    return false;
  }
}

function buildTicketChannelLink(channel) {
  const safeName = String(channel?.name || 'ticket').replace(/([\[\]])/g, '\\$1');
  return `[#${safeName}](https://discord.com/channels/${channel.guild.id}/${channel.id})`;
}

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

      const hasAccess = await ensureTicketCreatorAccess(channel, interaction.user.id);
      if (!hasAccess) {
        throw Object.assign(new Error('Ticket creator access could not be verified'), {
          userMessage: 'Your ticket was created, but Cloudy could not verify your access to it. Please contact an admin.',
        });
      }

      const channelLink = buildTicketChannelLink(channel);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('Ticket Created', `Your ticket has been created in ${channelLink}!`)],
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
        handler: 'ticket',
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
      logger.error('Ticket close modal failed', {
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
