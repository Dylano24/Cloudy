import { createEmbed } from '../../utils/embeds.js';
// moderationService.js

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { logModerationAction } from '../../utils/moderation.js';
import { hasCloudyOwnerMember } from '../ownerRoleAccess.js';


function getTargetLabel(target) {
  return target.user?.tag ?? target.displayName ?? 'this user';
}

function getHighestRole(member) {
  return member?.roles?.highest ?? null;
}

export class ModerationService {

  static buildHierarchyMessage({ actor, actorRole, targetRole, targetLabel, action }) {
    if (actor === 'moderator') {
      return (
        `You cannot ${action} **${targetLabel}** — their role **${targetRole.name}** is equal to or above yours (**${actorRole.name}**). ` +
        `In **Server Settings → Roles**, drag your moderator role above **${targetRole.name}**.`
      );
    }

    return (
      `I cannot ${action} **${targetLabel}** — my role **${actorRole.name}** is equal to or below theirs (**${targetRole.name}**). ` +
      `In **Server Settings → Roles**, drag my bot role above **${targetRole.name}**.`
    );
  }

  static buildHierarchySkipReason(moderator, target, action, actor = 'moderator') {
    const targetLabel = getTargetLabel(target);
    const targetRole = getHighestRole(target);

    if (actor === 'bot') {
      const botMember = target.guild?.members?.me;
      const botRole = getHighestRole(botMember);
      if (!botRole || !targetRole) {
        return `Bot role hierarchy blocked ${action} for ${targetLabel}`;
      }
      return `Bot role **${botRole.name}** is too low for **${targetRole.name}** — move the bot role higher`;
    }

    const modRole = getHighestRole(moderator);
    if (!modRole || !targetRole) {
      return `Role hierarchy blocked ${action} for ${targetLabel}`;
    }
    return `Your role **${modRole.name}** is too low for **${targetRole.name}** — move your role higher`;
  }

  static validateHierarchy(moderator, target, action) {
    if (!moderator || !target) {
      return { valid: false, error: 'Invalid moderator or target' };
    }

    if (moderator.guild?.ownerId === moderator.id) {
      return { valid: true };
    }

    const modRole = getHighestRole(moderator);
    const targetRole = getHighestRole(target);

    if (!modRole || !targetRole) {
      return {
        valid: false,
        error: 'Could not resolve role hierarchy. Try mentioning the user or use the slash command.',
      };
    }

    if (modRole.position <= targetRole.position) {
      return {
        valid: false,
        error: this.buildHierarchyMessage({
          actor: 'moderator',
          actorRole: modRole,
          targetRole,
          targetLabel: getTargetLabel(target),
          action,
        }),
      };
    }

    return { valid: true };
  }

  static validateBotHierarchy(target, action) {
    if (!target) {
      return { valid: false, error: 'Invalid target' };
    }

    const botMember = target.guild?.members?.me;
    if (!botMember) {
      return { valid: false, error: 'Bot is not in the guild' };
    }

    const botRole = getHighestRole(botMember);
    const targetRole = getHighestRole(target);

    if (!botRole || !targetRole) {
      return {
        valid: false,
        error: 'Could not resolve bot role hierarchy. Check that my role is configured in this server.',
      };
    }

    if (botRole.position <= targetRole.position) {
      return {
        valid: false,
        error: this.buildHierarchyMessage({
          actor: 'bot',
          actorRole: botRole,
          targetRole,
          targetLabel: getTargetLabel(target),
          action,
        }),
      };
    }

    return { valid: true };
  }

  static assertModerationHierarchy(moderator, target, action) {
    const botCheck = this.validateBotHierarchy(target, action);
    if (!botCheck.valid) {
      throw new TitanBotError(botCheck.error, ErrorTypes.PERMISSION, botCheck.error);
    }

    const modCheck = this.validateHierarchy(moderator, target, action);
    if (!modCheck.valid) {
      throw new TitanBotError(modCheck.error, ErrorTypes.PERMISSION, modCheck.error);
    }
 …13549 tokens truncated…  throw ticketError('Ticket is closed', 'This ticket is already closed.');
  }
  if (ticketData.claimedBy && String(ticketData.claimedBy) !== String(claimer.id)) {
    throw ticketError(
      'Ticket already claimed',
      `This ticket is already claimed by <@${ticketData.claimedBy}>.`,
    );
  }
  if (String(ticketData.claimedBy || '') === String(claimer.id)) {
    await syncCloudyTicketMessage(channel);
    await sendPublicClaimStatus(channel, claimer);
    return ticketData;
  }

  ticketData.claimedBy = claimer.id;
  ticketData.claimedAt = new Date().toISOString();
  await saveTicketDataFast(channel, ticketData);
  await syncCloudyTicketMessage(channel);

  await sendPublicClaimStatus(channel, claimer);

  void logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'claim',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: claimer.id,
      metadata: { claimedAt: ticketData.claimedAt },
    },
  }).catch(() => {});

  return ticketData;
}

export async function unclaimTicket(channel, unclaimer) {
  const ticketData = await getTicketDataFast(channel);
  if (!ticketData) {
    throw ticketError('Ticket data not found', 'This is not a valid ticket channel.');
  }
  if (!ticketData.claimedBy) {
    await syncCloudyTicketMessage(channel);
    return ticketData;
  }

  const previousClaimer = ticketData.claimedBy;
  ticketData.claimedBy = null;
  ticketData.claimedAt = null;
  await saveTicketDataFast(channel, ticketData);
  await syncCloudyTicketMessage(channel);

  await sendPublicUnclaimStatus(channel, unclaimer);

  void logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'unclaim',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: unclaimer.id,
      metadata: { previousClaimer },
    },
  }).catch(() => {});

  return ticketData;
}

async function finishCloseSideEffects(channel, ticketData) {
  try {
    const config = await withTimeout(
      getGuildConfig(channel.client, channel.guild.id),
      DB_TIMEOUT_MS,
      'Close ticket config read',
    ).catch(() => null);

    const closedCategoryId = config?.ticketClosedCategoryId || null;
    if (closedCategoryId && channel.parentId !== closedCategoryId) {
      const category = channel.guild.channels.cache.get(closedCategoryId)
        || await channel.guild.channels.fetch(closedCategoryId).catch(() => null);
      if (category?.type === ChannelType.GuildCategory) {
        await channel.setParent(closedCategoryId, { lockPermissions: false }).catch(() => {});
      }
    }

    await hideClosedTicket(channel);
  } catch (error) {
    logger.warn('Ticket close side effects failed', {
      guildId: channel.guild.id,
      channelId: channel.id,
      error: error.message,
    });
  }
}

export async function closeTicket(channel, closer, reason = 'No reason provided') {
  const ticketData = await getTicketDataFast(channel);
  if (!ticketData) {
    throw ticketError('Ticket data not found', 'This is not a valid ticket channel.');
  }

  await hideClosedTicket(channel, { closing: true });

  if (String(ticketData.status || 'open').toLowerCase() === 'closed') {
    await syncCloudyTicketMessage(channel);
    return ticketData;
  }

  ticketData.status = 'closed';
  ticketData.closedBy = closer.id;
  ticketData.closedAt = new Date().toISOString();
  ticketData.closeReason = reason;
  await saveTicketDataFast(channel, ticketData);
  await syncCloudyTicketMessage(channel);

  const closeEmbed = createEmbed({
    title: 'Ticket closed',
    description:
      `This ticket has been closed by ${closer}.\n` +
      `**Reason:** ${reason}\n` +
      `**Ticket:** #${ticketNumberOf(ticketData)}`,
    color: '#FFFFFF',
  });
  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_reopen')
      .setLabel('Reopen Ticket')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔓'),
    new ButtonBuilder()
      .setCustomId('ticket_delete')
      .setLabel('Delete Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
  );

  await withTimeout(
    channel.send({ embeds: [forceCloudyTicketFooter(closeEmbed)], components: [controlRow] }),
    DISCORD_TIMEOUT_MS,
    'Close ticket status message',
  ).catch(error => {
    logger.warn('Could not send close status message quickly', {
      channelId: channel.id,
      error: error.message,
    });
  });

  void logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'close',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: closer.id,
      reason,
      metadata: { closedAt: ticketData.closedAt, dmSent: false },
    },
  }).catch(() => {});

  const timer = setTimeout(() => {
    finishCloseSideEffects(channel, ticketData).catch(() => {});
  }, 1000);
  timer.unref?.();

  return ticketData;
}

export async function reopenTicket(channel, reopener) {
  let result;
  try {
    result = await reopenTicketBase(channel, reopener);
  } finally {
    await syncCloudyTicketMessage(channel);
    await syncCloudyTicketChannelName(channel);
  }
  return result;
}

export async function updateTicketPriority(channel, priority, updater) {
  const normalizedPriority = normalizePriorityKey(priority);
  const priorityInfo = PRIORITY_MAP[normalizedPriority];
  if (!priorityInfo) {
    throw ticketError('Invalid ticket priority', 'Invalid priority selected.');
  }

  const ticketData = await getTicketDataFast(channel);
  if (!ticketData) {
    throw ticketError(
      'Ticket data not found',
      'This action can only be used in a valid ticket channel.',
    );
  }

  const previousPriority = normalizePriorityKey(ticketData.priority);
  ticketData.priority = normalizedPriority;
  ticketData.priorityUpdatedBy = updater.id;
  ticketData.priorityUpdatedAt = new Date().toISOString();

  await saveTicketDataFast(channel, ticketData);
  scheduleTicketChannelNameSync(channel, {
    priority: normalizedPriority,
    pinned: getQueuedPinnedState(channel),
  });
  await syncCloudyTicketMessage(channel);

  void logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'priority',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: updater.id,
      priority: normalizedPriority,
      metadata: { previousPriority, priority: normalizedPriority },
    },
  }).catch(() => {});

  logger.info('Ticket priority updated', {
    guildId: channel.guild.id,
    channelId: channel.id,
    previousPriority,
    priority: normalizedPriority,
    updaterId: updater.id,
  });

  return ticketData;
}

export {
  deleteTicket,
  getUserTicketCount,
};
