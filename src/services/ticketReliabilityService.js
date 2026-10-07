import { hideClosedTicket, restoreReopenedTicketAccess } from './ticketClosedAccessService.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import {
  createTicket as createTicketBase,
  setTicketPinned as setTicketPinnedBase,
  syncCloudyTicketChannelName,
  syncCloudyTicketMessage,
} from './ticketUiService.js';
import { deleteTicketSafely } from './ticketDeleteService.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import {
  getTicketData,
  saveTicketData,
} from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { requireTicketCloseReason } from './ticketActionPolicy.js';
import { getPinnedMessages } from '../utils/messagePins.js';
import { createEmbed } from '../utils/embeds.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { decorateEmbedWithSavedTemplate } from './embedTemplateService.js';

const creationQueues = new Map();
const mutationQueues = new Map();
const reconcileTimers = new Map();

function ticketError(message, userMessage, code = 'TICKET_RELIABILITY_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.userMessage = userMessage;
  return error;
}


function cloneTicketData(ticketData) {
  return ticketData ? structuredClone(ticketData) : null;
}

function mutationKey(channel) {
  return `${channel.guild.id}:${channel.id}`;
}

function canReuseMutationContext(channel) {
  return !mutationQueues.has(mutationKey(channel));
}

async function ticketDataForMutation(channel, providedTicketData = null) {
  const provided = cloneTicketData(providedTicketData);
  if (provided) return provided;
  return getTicketData(channel.guild.id, channel.id);
}

function ticketNumberOf(ticketData) {
  return ticketData?.ticketNumber || ticketData?.id || 'Unknown';
}

function normalizePriority(value) {
  const key = String(value || 'none').toLowerCase();
  if (key === 'urgent') return 'high';
  return PRIORITY_MAP[key] ? key : 'none';
}

async function sendTicketStatus(channel, { title, description, color = '#FFFFFF', userId = null, components = [] }) {
  const payload = {
    embeds: [forceCloudyTicketFooter(createEmbed({ title, description, color }))],
    components,
    allowedMentions: userId
      ? { parse: [], users: [String(userId)] }
      : { parse: [] },
  };

  return channel.send(payload).catch(error => {
    logger.warn('Could not send ticket status message quickly', {
      channelId: channel.id,
      title,
      error: error.message,
    });
    return null;
  });
}

function logTicketMutation(channel, event) {
  void logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event,
  }).catch(() => {});
}

function enqueue(queue, key, operation) {
  const previous = queue.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queue.set(key, current);
  current.finally(() => {
    if (queue.get(key) === current) queue.delete(key);
  }).catch(() => {});
  return current;
}

function clearTicketReconcileTimers(channel) {
  const guildId = channel?.guild?.id;
  const channelId = channel?.id;
  if (!guildId || !channelId) return;

  const key = `${guildId}:${channelId}`;
  const timers = reconcileTimers.get(key) || [];
  for (const timer of timers) clearTimeout(timer);
  reconcileTimers.delete(key);
}

function isLiveGuildChannel(channel) {
  if (!channel?.guild?.id || !channel?.id) return false;
  if (channel.deleted === true) return false;
  return channel.guild.channels.cache.has(channel.id);
}

export function requirePersistentTicketDatabase(client) {
  if (!client?.db) {
    throw ticketError(
      'Ticket database client is unavailable',
      'The persistent ticket database is currently unavailable. Please try again shortly.',
      'TICKET_DATABASE_UNAVAILABLE',
    );
  }

  const status = client.db.getStatus?.();
  const degraded = client.db.isDegraded?.() === true || status?.isDegraded === true;
  const unavailable = typeof client.db.isAvailable === 'function' && !client.db.isAvailable();

  if (degraded || unavailable) {
    throw ticketError(
      'Persistent PostgreSQL ticket database is unavailable',
      'The persistent ticket database is currently unavailable. Please try again once PostgreSQL is connected.',
      'TICKET_DATABASE_UNAVAILABLE',
    );
  }

  return true;
}

async function getStrictOpenTicketCount(client, guildId, userId) {
  requirePersistentTicketDatabase(client);

  const pool = client.db?.db?.pool;
  if (!pool?.query) {
    throw ticketError(
      'PostgreSQL pool is unavailable for ticket count',
      'The ticket database is not ready yet. Please try again in a moment.',
      'TICKET_DATABASE_UNAVAILABLE',
    );
  }

  try {
    const { pgConfig } = await import('../config/database/postgres.js');
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM ${pgConfig.tables.tickets}
       WHERE guild_id = $1
         AND data->>'userId' = $2
         AND data->>'status' = 'open'`,
      [guildId, userId],
    );
    return Number(result.rows?.[0]?.count || 0);
  } catch (error) {
    logger.error('Strict ticket count failed', {
      guildId,
      userId,
      error: error.message,
    });
    throw ticketError(
      'Could not verify open ticket count',
      'The ticket database could not verify your open tickets. Please try again.',
      'TICKET_DATABASE_READ_FAILED',
    );
  }
}

function extractTicketNumber(message, channel) {
  const title = message?.embeds?.[0]?.title || '';
  const titleMatch = title.match(/^Ticket\s+#(.+)$/i);
  if (titleMatch?.[1]) return titleMatch[1].trim();

  const channelMatch = String(channel?.name || '').match(/ticket-(\d+)/i);
  return channelMatch?.[1] || null;
}

async function findMainTicketMessage(channel, ticketData = null, preferredMessage = null) {
  if (!channel?.messages?.fetch || !isLiveGuildChannel(channel)) return null;

  const isMain = message => {
    if (message?.author?.id !== channel.client.user?.id) return false;
    if (message.embeds?.[0]?.title?.startsWith('Ticket #')) return true;
    try {
      const serialized = JSON.stringify(
        message.components?.map(component => component.toJSON?.() ?? component) || [],
      );
      return serialized.includes('Ticket #');
    } catch {
      return false;
    }
  };

  if (isMain(preferredMessage)) return preferredMessage;

  if (ticketData?.ticketMessageId) {
    const direct = await channel.messages.fetch(ticketData.ticketMessageId).catch(() => null);
    if (isMain(direct)) return direct;
  }

  if (typeof channel.messages.fetchPins === 'function') {
    const pinned = await channel.messages.fetchPins().catch(() => null);
    const found = getPinnedMessages(pinned).find(isMain);
    if (found) return found;
  } else if (typeof channel.messages.fetchPinned === 'function') {
    const pinned = await channel.messages.fetchPinned().catch(() => null);
    const found = pinned?.find?.(isMain);
    if (found) return found;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return recent?.find?.(isMain) || null;
}

async function stabilizeCreatedTicket(channel, fallbackTicketData = null, preferredMessage = null) {
  const ticketData = fallbackTicketData
    || await getTicketData(channel.guild.id, channel.id).catch(() => null);
  if (!ticketData) return null;

  const mainMessage = await findMainTicketMessage(channel, ticketData, preferredMessage);
  if (!mainMessage) return null;

  let changed = false;
  if (ticketData.ticketMessageId !== mainMessage.id) {
    ticketData.ticketMessageId = mainMessage.id;
    changed = true;
  }
  if (ticketData.ticketNumber == null) {
    const ticketNumber = extractTicketNumber(mainMessage, channel);
    if (ticketNumber) {
      ticketData.ticketNumber = ticketNumber;
      changed = true;
    }
  }
  if (ticketData.pinned == null) {
    ticketData.pinned = String(channel.name || '').includes('📌');
    changed = true;
  }

  if (changed) {
    await saveTicketData(channel.guild.id, channel.id, ticketData);
  }

  await syncCloudyTicketMessage(channel, mainMessage);
  await syncCloudyTicketChannelName(channel);
  return { channel, ticketData };
}

function findNewTicketChannels(guild, beforeIds, memberId) {
  return [...guild.channels.cache.values()]
    .filter(channel =>
      !beforeIds.has(channel.id)
      && channel.type === ChannelType.GuildText
      && /ticket-\d+/i.test(String(channel.name || ''))
      && channel.permissionOverwrites?.cache?.has?.(memberId)
    )
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function cleanupIncompleteTicket(channel) {
  logger.warn('Preserving ticket channel after incomplete UI stabilization', {
    guildId: channel?.guild?.id,
    channelId: channel?.id,
  });
  return false;
}

export async function checkTicketCreationLimit(guild, userId, config) {
  const maxTickets = Number(config.maxTicketsPerUser ?? 3);
  const currentCount = await getStrictOpenTicketCount(guild.client, guild.id, userId);
  if (currentCount >= maxTickets) throw ticketError('Ticket limit reached',
    `You have reached the maximum number of open tickets (${maxTickets}). Please close your existing tickets before creating a new one.`, 'TICKET_LIMIT_REACHED');
}

export async function createTicket(guild, member, categoryId, reason, priority = 'none') {
  const queueKey = `${guild.id}:${member.id}`;

  return enqueue(creationQueues, queueKey, async () => {
    requirePersistentTicketDatabase(guild.client);

    let config = await getGuildConfig(guild.client, guild.id);
    const namedStaffRole = guild.roles.cache.find(
      role => role.name.trim().toLowerCase() === 'staff',
    );
    if (namedStaffRole && !config.ticketStaffRoleId) {
      config = await updateGuildConfig(guild.client, guild.id, {
        ticketStaffRoleId: namedStaffRole.id,
      });
    }

    const maxTickets = Number(config.maxTicketsPerUser ?? 3);
    const currentCount = await getStrictOpenTicketCount(guild.client, guild.id, member.id);

    if (currentCount >= maxTickets) {
      throw ticketError(
        `Member ${member.id} reached max open tickets`,
        `You have reached the maximum number of open tickets (${maxTickets}). Please close your existing tickets before creating a new one.`,
        'TICKET_LIMIT_REACHED',
      );
    }

    if (categoryId) {
      const configuredCategory = guild.channels.cache.get(categoryId)
        || await guild.channels.fetch(categoryId).catch(() => null);
      if (!configuredCategory || configuredCategory.type !== ChannelType.GuildCategory) {
        throw ticketError(
          `Configured open ticket category ${categoryId} is invalid`,
          'The configured open-ticket category no longer exists. An admin must update it in `/ticket dashboard`.',
          'TICKET_CATEGORY_INVALID',
        );
      }
    }

    if (config.ticketStaffRoleId) {
      const staffRole = guild.roles.cache.get(config.ticketStaffRoleId)
        || await guild.roles.fetch(config.ticketStaffRoleId).catch(() => null);
      if (!staffRole) {
        throw ticketError(
          `Configured ticket staff role ${config.ticketStaffRoleId} is invalid`,
          'The configured Ticket Staff Role no longer exists. An admin must update it in `/ticket dashboard`.',
          'TICKET_STAFF_ROLE_INVALID',
        );
      }
      for (const id of new Set([categoryId, config.ticketClosedCategoryId].filter(Boolean))) {
        const category = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
        if (category?.type === ChannelType.GuildCategory) {
          await category.permissionOverwrites.edit(staffRole.id, {
            ViewChannel: true, ReadMessageHistory: true,
          });
        }
      }
    }

    const beforeIds = new Set(guild.channels.cache.keys());

    try {
      const result = await createTicketBase(
        guild,
        member,
        categoryId,
        reason,
        priority,
        { config, skipLimitCheck: true },
      );
      const stabilized = await stabilizeCreatedTicket(
        result.channel,
        result.ticketData,
        result.ticketMessage,
      );
      if (!stabilized) {
        throw ticketError(
          'Ticket was created without complete persistent state',
          'The ticket could not be completed safely. Please try again.',
          'TICKET_CREATION_INCOMPLETE',
        );
      }
      return stabilized;
    } catch (error) {
      const candidates = findNewTicketChannels(guild, beforeIds, member.id);

      for (const channel of candidates) {
        const recovered = await stabilizeCreatedTicket(channel).catch(() => null);
        if (recovered) {
          logger.warn('Recovered a ticket after a late creation error', {
            guildId: guild.id,
            userId: member.id,
            channelId: channel.id,
            originalError: error.message,
          });
          return recovered;
        }
        const preservedData = await getTicketData(guild.id, channel.id).catch(() => null);
        if (preservedData) {
          logger.warn('Preserved newly-created ticket after UI stabilization failure', {
            guildId: guild.id,
            userId: member.id,
            channelId: channel.id,
            originalError: error.message,
          });
          return { channel, ticketData: preservedData };
        }
        await cleanupIncompleteTicket(channel);
      }

      throw error;
    }
  });
}

function mutate(channel, operation) {
  requirePersistentTicketDatabase(channel.client);
  return enqueue(mutationQueues, `${channel.guild.id}:${channel.id}`, operation);
}

export async function claimTicket(channel, claimer, providedTicketData = null) {
  const reusable = canReuseMutationContext(channel) ? providedTicketData : null;

  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError('Ticket data not found', 'This is not a valid ticket channel.', 'TICKET_NOT_FOUND');
    }
    if (String(ticketData.status || 'open').toLowerCase() === 'closed') {
      throw ticketError('Ticket is closed', 'This ticket is already closed.', 'TICKET_CLOSED');
    }
    if (ticketData.claimedBy && String(ticketData.claimedBy) !== String(claimer.id)) {
      throw ticketError(
        'Ticket already claimed',
        `This ticket is already claimed by <@${ticketData.claimedBy}>.`,
        'TICKET_ALREADY_CLAIMED',
      );
    }

    const alreadyClaimedByActor = String(ticketData.claimedBy || '') === String(claimer.id);
    if (!alreadyClaimedByActor) {
      ticketData.claimedBy = claimer.id;
      ticketData.claimedAt = new Date().toISOString();
      await saveTicketData(channel.guild.id, channel.id, ticketData);
    }

    const claimerId = String(claimer?.id || claimer?.user?.id || '').trim();
    await sendTicketStatus(channel, {
      title: 'Ticket claimed',
      description: `${claimerId ? `<@${claimerId}>` : 'A staff member'} has claimed this ticket.`,
      color: '#2ecc71',
      userId: claimerId || null,
    });

    // The visible acknowledgement is already delivered. Keep the heavier main
    // ticket render after it so a history/pin fetch can never delay feedback.
    await syncCloudyTicketMessage(channel);

    if (!alreadyClaimedByActor) {
      logTicketMutation(channel, {
        type: 'claim',
        ticketId: channel.id,
        ticketNumber: ticketNumberOf(ticketData),
        userId: ticketData.userId,
        executorId: claimer.id,
        metadata: { claimedAt: ticketData.claimedAt },
      });
    }

    return ticketData;
  });
}

export async function unclaimTicket(channel, unclaimer, providedTicketData = null) {
  const reusable = canReuseMutationContext(channel) ? providedTicketData : null;

  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError('Ticket data not found', 'This is not a valid ticket channel.', 'TICKET_NOT_FOUND');
    }
    if (!ticketData.claimedBy) {
      await syncCloudyTicketMessage(channel);
      return ticketData;
    }

    const previousClaimer = ticketData.claimedBy;
    ticketData.claimedBy = null;
    ticketData.claimedAt = null;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const unclaimerId = String(unclaimer?.id || unclaimer?.user?.id || '').trim();
    await sendTicketStatus(channel, {
      title: 'Ticket unclaimed',
      description: `${unclaimerId ? `<@${unclaimerId}>` : 'A staff member'} has unclaimed this ticket.`,
      color: '#2ecc71',
      userId: unclaimerId || null,
    });

    await syncCloudyTicketMessage(channel);

    logTicketMutation(channel, {
      type: 'unclaim',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: unclaimer.id,
      metadata: { previousClaimer },
    });

    return ticketData;
  });
}

export async function updateTicketPriority(channel, priority, updater, providedTicketData = null) {
  const requestedPriority = String(priority || '').toLowerCase();
  const normalizedPriority = requestedPriority === 'urgent' ? 'high' : requestedPriority;
  if (!PRIORITY_MAP[normalizedPriority]) {
    throw ticketError('Invalid ticket priority', 'Invalid priority selected.');
  }

  const reusable = canReuseMutationContext(channel) ? providedTicketData : null;
  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError(
        'Ticket data not found',
        'This action can only be used in a valid ticket channel.',
        'TICKET_NOT_FOUND',
      );
    }

    const previousPriority = normalizePriority(ticketData.priority);
    ticketData.priority = normalizedPriority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    // Channel naming and the full ticket render are cosmetic follow-up work.
    // Start them immediately, but never make the user's success response wait.
    void setTicketPinnedBase(channel, Boolean(ticketData.pinned)).catch(() => {});
    void syncCloudyTicketMessage(channel).catch(() => {});

    logTicketMutation(channel, {
      type: 'priority',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: updater.id,
      priority: normalizedPriority,
      metadata: { previousPriority, priority: normalizedPriority },
    });

    return ticketData;
  });
}

async function applyPinnedState(channel, pinned, providedTicketData = null) {
  const ticketData = await ticketDataForMutation(channel, providedTicketData);
  if (!ticketData) {
    throw ticketError(
      'Ticket data not found while updating pin state',
      'This action can only be used in a valid ticket channel.',
      'TICKET_NOT_FOUND',
    );
  }
  if (String(ticketData.status || 'open').toLowerCase() === 'closed') {
    throw ticketError('Cannot pin closed ticket', 'This ticket is already closed.', 'TICKET_CLOSED');
  }

  ticketData.pinned = Boolean(pinned);
  ticketData.pinnedUpdatedAt = new Date().toISOString();
  await saveTicketData(channel.guild.id, channel.id, ticketData);

  // setTicketPinnedBase only schedules the Discord channel-name update. It can
  // safely complete after the durable state change and visible interaction.
  void setTicketPinnedBase(channel, Boolean(pinned)).catch(() => {});
  return Boolean(pinned);
}

export async function setTicketPinned(channel, pinned) {
  return mutate(channel, () => applyPinnedState(channel, pinned));
}

export async function toggleTicketPinned(channel, providedTicketData = null) {
  const reusable = canReuseMutationContext(channel) ? providedTicketData : null;

  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError(
        'Ticket data not found while toggling pin state',
        'This action can only be used in a valid ticket channel.',
        'TICKET_NOT_FOUND',
      );
    }

    const currentPinned = ticketData.pinned == null
      ? String(channel.name || '').includes('📌')
      : Boolean(ticketData.pinned);

    return applyPinnedState(channel, !currentPinned, ticketData);
  });
}

export async function closeTicket(channel, closer, reason, options = {}) {
  reason = requireTicketCloseReason(reason);
  const reusable = canReuseMutationContext(channel) ? options.ticketData : null;

  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError('Ticket data not found', 'This is not a valid ticket channel.', 'TICKET_NOT_FOUND');
    }

    if (String(ticketData.status || 'open').toLowerCase() === 'closed') {
      // The durable close may have succeeded before Discord permission cleanup
      // failed. Retrying must finish that cleanup even though status is closed.
      await hideClosedTicket(channel);
      await syncCloudyTicketMessage(channel);
      if (typeof options.onVisible === 'function') await options.onVisible().catch(() => {});
      scheduleTicketReconcile(channel, [1000, 5000, 20000]);
      return ticketData;
    }

    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    // Closed tickets are staff-only from the moment the close result is posted.
    // This applies whether staff or the ticket creator closes the ticket.
    // Staff retain access through the staff role; non-staff creators must not
    // see the closed status or the Reopen/Delete controls.
    await hideClosedTicket(channel);

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

    // Deliver the visible close result before permission cleanup, history
    // discovery and category reconciliation.
    await sendTicketStatus(channel, {
      title: 'Ticket closed',
      description:
        `This ticket has been closed by ${closer}.\n`
        + `**Reason:** ${reason}\n`
        + `**Ticket:** #${ticketNumberOf(ticketData)}`,
      color: 0xFF7A00,
      components: [controlRow],
    });

    // Allow the interaction layer to clear its private "thinking" response as
    // soon as the public close result is visible, before permission cleanup.
    if (typeof options.onVisible === 'function') {
      await options.onVisible().catch(() => {});
    }

    await Promise.allSettled([
      syncCloudyTicketMessage(channel),
    ]);

    logTicketMutation(channel, {
      type: 'close',
      ticketId: channel.id,
      ticketNumber: ticketNumberOf(ticketData),
      userId: ticketData.userId,
      executorId: closer.id,
      reason,
      metadata: { closedAt: ticketData.closedAt, dmSent: false },
    });

    scheduleTicketReconcile(channel, [1000, 5000, 20000]);
    return ticketData;
  });
}

export async function reopenTicket(channel, reopener, options = {}) {
  const reusable = canReuseMutationContext(channel) ? options.ticketData : null;

  return mutate(channel, async () => {
    const ticketData = await ticketDataForMutation(channel, reusable);
    if (!ticketData) {
      throw ticketError('Ticket data not found', 'This is not a valid ticket channel.', 'TICKET_NOT_FOUND');
    }
    if (String(ticketData.status || '').toLowerCase() !== 'closed') {
      throw ticketError('Ticket not closed', 'This ticket is not currently closed.', 'TICKET_NOT_CLOSED');
    }

    ticketData.status = 'open';
    ticketData.closedBy = null;
    ticketData.closedAt = null;
    ticketData.closeReason = null;
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const config = options.config || await getGuildConfig(channel.client, channel.guild.id).catch(() => ({}));
    const reopenEmbed = createEmbed({
      title: 'Ticket reopened',
      description: `🔓 ${reopener} has reopened this ticket!`,
      color: '#2ecc71',
    });

    // Keep the saved Builder decoration and creator ping from the established
    // reopen lifecycle, but use the already-known close status message instead
    // of scanning channel history to find it.
    const decorationPromise = decorateEmbedWithSavedTemplate(
      channel.guild.id,
      config.ticketLogsChannelId || channel.id,
      reopenEmbed,
    );
    const closeStatusCleanup = options.statusMessage?.edit
      ? options.statusMessage.edit({ components: [] }).catch(() => null)
      : Promise.resolve(null);
    const ownerAccessTask = channel.permissionOverwrites.edit(ticketData.userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });

    // Restore the creator's channel access before sending the mention. A mention
    // sent while the ticket is still hidden can render as a tag without creating
    // a real Discord notification for the ticket creator.
    const [decoratedReopen] = await Promise.all([
      decorationPromise,
      closeStatusCleanup,
      ownerAccessTask,
    ]);

    await channel.send({
      content: `<@${ticketData.userId}>`,
      embeds: [forceCloudyTicketFooter(decoratedReopen.embed)],
      allowedMentions: { parse: [], users: [String(ticketData.userId)] },
    });

    const openCategoryId = config?.ticketCategoryId || null;

    const categoryTask = async () => {
      if (!openCategoryId || channel.parentId === openCategoryId) return;
      const category = channel.guild.channels.cache.get(openCategoryId)
        || await channel.guild.channels.fetch(openCategoryId).catch(() => null);
      if (category?.type === ChannelType.GuildCategory) {
        await channel.setParent(openCategoryId, { lockPermissions: false });
      }
    };

    // All remaining work is independent once the durable state and visible
    // status are updated, so run it concurrently instead of serially.
    await Promise.allSettled([
      categoryTask(),
      restoreReopenedTicketAccess(channel, ticketData),
      syncCloudyTicketMessage(channel),
      syncCloudyTicketChannelName(channel),
    ]);

    scheduleTicketReconcile(channel, [5000, 20000]);
    return { ticketData, movedToOpenCategory: channel.parentId === openCategoryId };
  });
}

export async function deleteTicket(channel, deleter, providedTicketData = null) {
  const reusable = canReuseMutationContext(channel) ? providedTicketData : null;

  return mutate(channel, async () => {
    clearTicketReconcileTimers(channel);
    return deleteTicketSafely(channel, deleter, reusable);
  });
}

export async function reconcileTicketChannelState(channel) {
  if (!isLiveGuildChannel(channel)) return false;
  requirePersistentTicketDatabase(channel.client);

  const ticketData = await getTicketData(channel.guild.id, channel.id);
  if (!ticketData || String(ticketData.status || '').toLowerCase() === 'deleted') return false;

  const config = await getGuildConfig(channel.client, channel.guild.id);
  const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
  let changed = false;

  if (ticketData.pinned == null) {
    ticketData.pinned = String(channel.name || '').includes('📌');
    changed = true;
  }

  if (changed) {
    await saveTicketData(channel.guild.id, channel.id, ticketData);
  }

  const targetCategoryId = isClosed
    ? config.ticketClosedCategoryId
    : config.ticketCategoryId;

  if (targetCategoryId && channel.parentId !== targetCategoryId) {
    const targetCategory = channel.guild.channels.cache.get(targetCategoryId)
      || await channel.guild.channels.fetch(targetCategoryId).catch(() => null);
    if (targetCategory?.type === ChannelType.GuildCategory && isLiveGuildChannel(channel)) {
      await channel.setParent(targetCategoryId, { lockPermissions: false }).catch(error => {
        if (isLiveGuildChannel(channel)) {
          logger.warn(`Ticket category reconciliation failed: ${error.message}`, {
            guildId: channel.guild.id,
            channelId: channel.id,
            targetCategoryId,
          });
        }
      });
    }
  }

  if (!isLiveGuildChannel(channel)) return false;

  if (isClosed) {
    await hideClosedTicket(channel);
  }

  const ownerPermissions = isClosed
    ? {
      ViewChannel: true,
      SendMessages: false,
    }
    : {
      ViewChannel: true,
      SendMessages: true,
      AttachFiles: true,
      ReadMessageHistory: true,
    };

  if (!isClosed) await channel.permissionOverwrites.edit(ticketData.userId, ownerPermissions).catch(error => {
    if (isLiveGuildChannel(channel)) {
      logger.warn(`Ticket owner permission reconciliation failed: ${error.message}`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: ticketData.userId,
      });
    }
  });

  if (isLiveGuildChannel(channel)) {
    const namedStaffRole = channel.guild.roles.cache.find(
      role => role.name.trim().toLowerCase() === 'staff',
    );
    const staffRoleId = config.ticketStaffRoleId || namedStaffRole?.id || null;
    const staffRole = staffRoleId
      ? channel.guild.roles.cache.get(staffRoleId)
        || await channel.guild.roles.fetch(staffRoleId).catch(() => null)
      : null;
    if (staffRole) {
      await channel.permissionOverwrites.edit(staffRole.id, {
        ViewChannel: true,
        SendMessages: true,
        AttachFiles: true,
        ReadMessageHistory: true,
      }).catch(error => {
        if (isLiveGuildChannel(channel)) {
          logger.warn(`Ticket staff permission reconciliation failed: ${error.message}`, {
            guildId: channel.guild.id,
            channelId: channel.id,
            roleId: staffRole.id,
          });
        }
      });
    }
  }

  if (!isLiveGuildChannel(channel)) return false;
  await syncCloudyTicketMessage(channel);
  await setTicketPinnedBase(channel, Boolean(ticketData.pinned)).catch(() => {});
  await syncCloudyTicketChannelName(channel);
  return true;
}

export function scheduleTicketReconcile(channel, delays = [1000, 5000, 20000]) {
  if (!isLiveGuildChannel(channel)) return;

  const key = `${channel.guild.id}:${channel.id}`;
  const existing = reconcileTimers.get(key) || [];
  for (const timer of existing) clearTimeout(timer);

  const timers = delays.map(delay => {
    const timer = setTimeout(() => {
      if (!isLiveGuildChannel(channel)) {
        clearTicketReconcileTimers(channel);
        return;
      }

      reconcileTicketChannelState(channel).catch(error => {
        if (![10003, 10008].includes(error?.code) && isLiveGuildChannel(channel)) {
          logger.warn(`Scheduled ticket reconciliation failed: ${error.message}`, {
            guildId: channel.guild.id,
            channelId: channel.id,
            delay,
          });
        }
      });
    }, delay);
    timer.unref?.();
    return timer;
  });

  reconcileTimers.set(key, timers);
  const cleanupTimer = setTimeout(() => reconcileTimers.delete(key), Math.max(...delays) + 1000);
  cleanupTimer.unref?.();
}

export async function recoverGuildTickets(guild) {
  requirePersistentTicketDatabase(guild.client);

  // Do not rely on the channel name: a manually renamed ticket is still a ticket
  // when its persistent database record exists.
  const channels = [...guild.channels.cache.values()]
    .filter(channel => channel.type === ChannelType.GuildText);

  let recovered = 0;
  for (const channel of channels) {
    const ticketData = await getTicketData(guild.id, channel.id).catch(() => null);
    if (!ticketData || String(ticketData.status || '').toLowerCase() === 'deleted') continue;

    await reconcileTicketChannelState(channel).catch(error => {
      logger.warn(`Ticket startup reconciliation failed: ${error.message}`, {
        guildId: guild.id,
        channelId: channel.id,
      });
    });
    recovered += 1;
  }

  return recovered;
}
