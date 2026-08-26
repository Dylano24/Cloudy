import { ChannelType } from 'discord.js';
import {
  claimTicket as claimTicketBase,
  closeTicket as closeTicketBase,
  createTicket as createTicketBase,
  reopenTicket as reopenTicketBase,
  setTicketPinned as setTicketPinnedBase,
  syncCloudyTicketChannelName,
  syncCloudyTicketMessage,
  unclaimTicket as unclaimTicketBase,
  updateTicketPriority as updateTicketPriorityBase,
} from './ticketUiService.js';
import { deleteTicketSafely } from './ticketDeleteService.js';
import { getGuildConfig } from './config/guildConfig.js';
import {
  getTicketData,
  saveTicketData,
} from '../utils/database.js';
import { logger } from '../utils/logger.js';

const creationQueues = new Map();
const mutationQueues = new Map();
const reconcileTimers = new Map();

function ticketError(message, userMessage, code = 'TICKET_RELIABILITY_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.userMessage = userMessage;
  return error;
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
    const found = pinned?.items?.find?.(isMain);
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

export async function createTicket(guild, member, categoryId, reason, priority = 'none') {
  const queueKey = `${guild.id}:${member.id}`;

  return enqueue(creationQueues, queueKey, async () => {
    requirePersistentTicketDatabase(guild.client);

    const config = await getGuildConfig(guild.client, guild.id);
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

export async function claimTicket(channel, claimer) {
  return mutate(channel, () => claimTicketBase(channel, claimer));
}

export async function unclaimTicket(channel, unclaimer) {
  return mutate(channel, () => unclaimTicketBase(channel, unclaimer));
}

export async function updateTicketPriority(channel, priority, updater) {
  return mutate(channel, async () => {
    const result = await updateTicketPriorityBase(channel, priority, updater);
    const latest = await getTicketData(channel.guild.id, channel.id).catch(() => null);
    if (latest?.pinned != null) {
      await setTicketPinnedBase(channel, Boolean(latest.pinned));
    }
    return result;
  });
}

async function applyPinnedState(channel, pinned) {
  const ticketData = await getTicketData(channel.guild.id, channel.id);
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
  await setTicketPinnedBase(channel, Boolean(pinned));
  return Boolean(pinned);
}

export async function setTicketPinned(channel, pinned) {
  return mutate(channel, () => applyPinnedState(channel, pinned));
}

export async function toggleTicketPinned(channel) {
  return mutate(channel, async () => {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
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

    return applyPinnedState(channel, !currentPinned);
  });
}

export async function closeTicket(channel, closer, reason = 'No reason provided') {
  return mutate(channel, async () => {
    const result = await closeTicketBase(channel, closer, reason);
    scheduleTicketReconcile(channel, [1000, 5000, 20000]);
    return result;
  });
}

export async function reopenTicket(channel, reopener) {
  return mutate(channel, async () => {
    const result = await reopenTicketBase(channel, reopener);
    await reconcileTicketChannelState(channel).catch(() => {});
    scheduleTicketReconcile(channel, [5000, 20000]);
    return result;
  });
}

export async function deleteTicket(channel, deleter) {
  return mutate(channel, async () => {
    clearTicketReconcileTimers(channel);
    return deleteTicketSafely(channel, deleter);
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

  const ownerPermissions = isClosed
    ? {
      ViewChannel: false,
      SendMessages: false,
    }
    : {
      ViewChannel: true,
      SendMessages: true,
      AttachFiles: true,
      ReadMessageHistory: true,
    };

  await channel.permissionOverwrites.edit(ticketData.userId, ownerPermissions).catch(error => {
    if (isLiveGuildChannel(channel)) {
      logger.warn(`Ticket owner permission reconciliation failed: ${error.message}`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: ticketData.userId,
      });
    }
  });

  if (config.ticketStaffRoleId && isLiveGuildChannel(channel)) {
    const staffRole = channel.guild.roles.cache.get(config.ticketStaffRoleId)
      || await channel.guild.roles.fetch(config.ticketStaffRoleId).catch(() => null);
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
