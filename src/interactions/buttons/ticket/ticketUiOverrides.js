import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../../utils/ticket/ticketPermissions.js';
import { getGuildConfig } from '../../../services/config/guildConfig.js';
import {
  buildCloudyTicketEmbed,
  scheduleTicketReplyDeletion,
} from '../../../utils/ticket/ticketBranding.js';
import {
  claimTicket,
  unclaimTicket,
  reopenTicket,
  checkTicketCreationLimit,
  toggleTicketPinned,
  updateTicketPriority,
} from '../../../services/ticketReliabilityService.js';
import { deleteTicketSafely as deleteTicket } from '../../../services/ticketDeleteService.js';
import { PRIORITY_MAP } from '../../../utils/helpers.js';
import { logTicketEvent } from '../../../utils/ticket/ticketLogging.js';
import { logger } from '../../../utils/logger.js';
import { buildUserErrorEmbed } from '../../../utils/embeds.js';

const PANEL_STATE_PRECHECK_MS = 1200;
export const TICKET_CREATION_LIMIT_PRECHECK_MS = 600;

async function getPanelStateFast(client, guildId) {
  let timer;
  try {
    return await Promise.race([
      getGuildConfig(client, guildId),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(null), PANEL_STATE_PRECHECK_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function precheckTicketCreationLimit(guild, userId, config) {
  if (!config) return false;

  let timer;
  try {
    return await Promise.race([
      checkTicketCreationLimit(guild, userId, config).then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), TICKET_CREATION_LIMIT_PRECHECK_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requireStaff(interaction, client, action, componentAcknowledged = false) {
  const reject = async (type, message) => {
    if (!componentAcknowledged) return replyUserError(interaction, { type, message });

    // deferUpdate acknowledges the public ticket message. Permission errors must
    // use a private follow-up, never edit that public message's original reply.
    return interaction.followUp({
      embeds: [buildUserErrorEmbed(type, message)],
      components: [],
      flags: MessageFlags.Ephemeral,
    });
  };
  const context = await getTicketPermissionContext({ client, interaction });

  if (context.ticketDataLookupFailed) {
    await reject(ErrorTypes.UNKNOWN, 'The ticket database is temporarily unavailable. Please try again.');
    return null;
  }

  if (!context.ticketData) {
    await reject(ErrorTypes.VALIDATION, 'This action can only be used in a valid ticket channel.');
    return null;
  }

  if (!context.canManageTicket) {
    await reject(ErrorTypes.PERMISSION, `Only the staff team can ${action}.`);
    return null;
  }

  return context;
}

async function editBasicTicketReply(interaction, title, description, components = []) {
  await InteractionHelper.safeEditReply(interaction, {
    content: '',
    embeds: [buildCloudyTicketEmbed({ title, description })],
    components,
  });
  scheduleTicketReplyDeletion(interaction);
}

const createTicketHandler = {
  name: 'create_ticket',
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Tickets can only be created inside a server.',
        });
      }

      const config = await getPanelStateFast(client, interaction.guildId);
      if (config?.ticketSystemDisabled === true) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'The ticket system is currently disabled.',
        });
      }

      if (
        config?.ticketPanelMessageId
        && interaction.message?.id
        && String(config.ticketPanelMessageId) !== String(interaction.message.id)
      ) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'This ticket panel is outdated. Please use the newest ticket panel.',
        });
      }

      const precheckCompleted = await precheckTicketCreationLimit(
        interaction.guild,
        interaction.user.id,
        config,
      );
      if (!precheckCompleted) {
        logger.debug('Ticket creation limit precheck timed out; deferring strict enforcement to modal submit', {
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Create a ticket');

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
          message: error.userMessage || 'Could not open the ticket form. Please try again.',
        });
      }
    }
  },
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      const context = await requireStaff(interaction, client, 'claim tickets', true);
      if (!context) return;

      await claimTicket(interaction.channel, interaction.user, context.ticketData);
    } catch (error) {
      logger.error('Ticket claim button failed', { error: error.message, channelId: interaction.channelId });
      const message = error?.userMessage || 'An error occurred while claiming the ticket.';

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          embeds: [buildCloudyTicketEmbed({ title: 'Error', description: message })],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message,
      });
    }
  },
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    // Component updates do not display Discord's long-lived "thinking"
    // placeholder. Keep legacy support for adapters missing a response webhook.
    const silentAck = typeof interaction.deferUpdate === 'function'
      && typeof interaction.followUp === 'function'
      && typeof interaction.webhook?.deleteMessage === 'function';
    if (silentAck) {
      try {
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
      } catch (error) {
        logger.warn('Ticket pin acknowledgement failed', { error: error.message });
        return;
      }
    } else {
      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;
    }

    try {
      const context = await requireStaff(interaction, client, 'pin tickets', silentAck);
      if (!context) return;

      const willBePinned = await toggleTicketPinned(interaction.channel, context.ticketData);

      interaction.channel.setPosition(willBePinned ? 0 : 999).catch(error => {
        logger.warn('Could not update ticket channel position', {
          channelId: interaction.channelId,
          error: error.message,
        });
      });

      const title = willBePinned ? 'Ticket pinned' : 'Ticket unpinned';
      const description = willBePinned
        ? 'This ticket has been pinned to the top of the category.'
        : 'This ticket has been moved back to its normal position.';
      if (silentAck) {
        const confirmation = await interaction.followUp({
          content: '',
          embeds: [buildCloudyTicketEmbed({ title, description })],
          components: [],
          flags: MessageFlags.Ephemeral,
        });
        // An ephemeral follow-up must be deleted by its own ID. Calling
        // deleteReply after deferUpdate risks deleting the public ticket.
        const privateId = confirmation?.id || confirmation?.resource?.message?.id;
        if (privateId) {
          const timer = setTimeout(() => {
            void interaction.webhook.deleteMessage(privateId).catch(() => {});
          }, 10_000);
          timer.unref?.();
        }
      } else {
        await editBasicTicketReply(interaction, title, description);
      }

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
      logger.error('Ticket pin button failed', { error: error.message, channelId: interaction.channelId });
      const message = error?.userMessage || 'Failed to pin or unpin the ticket.';
      if (silentAck) {
        await interaction.followUp({
          embeds: [buildUserErrorEmbed(ErrorTypes.UNKNOWN, message)],
          components: [],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message });
      }
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

      const storedPriority = String(context.ticketData.priority || 'none').toLowerCase();
      const currentPriority = storedPriority === 'urgent' ? 'high' : storedPriority;
      const currentInfo = PRIORITY_MAP[currentPriority] || PRIORITY_MAP.none;

      const menu = new StringSelectMenuBuilder()
        .setCustomId('ticket_priority_select')
        .setPlaceholder('Select a new priority...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('High').setValue('high').setEmoji('🔴'),
          new StringSelectMenuOptionBuilder().setLabel('Medium').setValue('medium').setEmoji('🟡'),
          new StringSelectMenuOptionBuilder().setLabel('Low').setValue('low').setEmoji('🔵'),
          new StringSelectMenuOptionBuilder().setLabel('None').setValue('none').setEmoji('⚪'),
        );

      await InteractionHelper.safeEditReply(interaction, {
        content: '',
        embeds: [buildCloudyTicketEmbed({
          title: 'Ticket priority',
          description: `Current priority: **${currentInfo.emoji} ${currentInfo.label}**\nSelect a new priority below.`,
        })],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
      scheduleTicketReplyDeletion(interaction);
    } catch (error) {
      logger.error('Priority menu button failed', { error: error.message, channelId: interaction.channelId });
      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: error?.userMessage || 'Could not open the priority menu.',
      });
    }
  },
};

const legacyPriorityHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args = []) {
    const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
    if (!deferred) return;

    try {
      const context = await requireStaff(interaction, client, 'change ticket priority');
      if (!context) return;

      const requestedPriority = String(args[0] || '').toLowerCase();
      const priority = requestedPriority === 'urgent' ? 'high' : requestedPriority;
      const info = PRIORITY_MAP[priority];
      if (!info) {
        await InteractionHelper.safeEditReply(interaction, {
          content: 'Invalid priority selected.',
          embeds: [],
          components: [],
        });
        return;
      }

      await updateTicketPriority(interaction.channel, priority, interaction.user, context.ticketData);
      await editBasicTicketReply(
        interaction,
        'Priority Updated',
        `Ticket priority has been set to **${info.emoji} ${info.label}**.`,
      );
    } catch (error) {
      logger.error('Legacy ticket priority button failed', {
        error: error.message,
        channelId: interaction.channelId,
      });
      await InteractionHelper.safeEditReply(interaction, {
        content: error?.userMessage || 'An error occurred while updating the ticket priority.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  },
};

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction) {
    try {
      if (!interaction.inGuild()) return;

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Close ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for closing')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Explain why you are closing this ticket...')
        .setRequired(true)
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
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      const context = await requireStaff(interaction, client, 'unclaim tickets', true);
      if (!context) return;

      await unclaimTicket(interaction.channel, interaction.member, context.ticketData);
    } catch (error) {
      logger.error('Ticket unclaim button failed', { error: error.message, channelId: interaction.channelId });
      const message = error?.userMessage || 'An error occurred while unclaiming the ticket.';

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          embeds: [buildCloudyTicketEmbed({ title: 'Error', description: message })],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message,
      });
    }
  },
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      // Acknowledge the component immediately. Unlike an ephemeral deferReply,
      // deferUpdate clears Discord's button spinner without keeping a private
      // "thinking" reply open while category/permission updates finish.
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      const context = await requireStaff(interaction, client, 'reopen tickets', true);
      if (!context) return;

      await reopenTicket(interaction.channel, interaction.member, {
        ticketData: context.ticketData,
        config: context.config,
        statusMessage: interaction.message,
      });
    } catch (error) {
      logger.error('Ticket reopen button failed', { error: error.message, channelId: interaction.channelId });
      const message = error?.userMessage || 'An error occurred while reopening the ticket.';

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          embeds: [buildCloudyTicketEmbed({ title: 'Error', description: message })],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message,
      });
    }
  },
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      // Transcript archival can take longer than a normal button action. Ack the
      // public component immediately so Discord never leaves the button loading.
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      const context = await requireStaff(interaction, client, 'delete tickets', true);
      if (!context) return;

      await deleteTicket(interaction.channel, interaction.user, context.ticketData);
    } catch (error) {
      logger.error('Ticket delete button failed', { error: error.message, channelId: interaction.channelId });
      const message = error?.userMessage || 'An error occurred while deleting the ticket.';

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          embeds: [buildCloudyTicketEmbed({ title: 'Error', description: message })],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message,
      });
    }
  },
};

export default [
  createTicketHandler,
  claimTicketHandler,
  pinTicketHandler,
  priorityMenuHandler,
  legacyPriorityHandler,
  closeTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler,
];
