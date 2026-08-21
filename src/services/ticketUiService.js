import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import {
  createTicket as createTicketBase,
  reopenTicket as reopenTicketBase,
  deleteTicket,
  getUserTicketCount,
} from './ticket.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { createEmbed } from '../utils/embeds.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { logger } from '../utils/logger.js';

export const TICKET_RECEIVED_MESSAGE =
  'we’ve received your request!\n\nTo help us process it as quickly as possible, feel free to provide any additional details you think may be useful, as well as any screenshots or files that could help us better understand your situation.\n\nOur team will be with you as soon as possible.';

const PIN_EMOJI = '📌';
const DB_TIMEOUT_MS = 2500;
const DISCORD_TIMEOUT_MS = 3500;
const CHANNEL_NAME_RETRY_MS = 15_000;
const channelNameJobs = new Map();

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`);
        error.code = 'TICKET_IO_TIMEOUT';
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function ticketError(message, userMessage) {
  const error = new Error(message);
  error.userMessage = userMessage;
  return error;
}

function ticketNumberOf(ticketData) {
  return ticketData?.ticketNumber || ticketData?.id;
}

async function getTicketDataFast(channel) {
  try {
    return await withTimeout(
      getTicketData(channel.guild.id, channel.id),
      DB_TIMEOUT_MS,
      'Ticket database read',
    );
  } catch (error) {
    logger.warn('Ticket database read timed out/failed', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      error: error.message,
    });
    throw ticketError(
      'Ticket database read failed',
      'The ticket database is taking too long to respond. Please try again.',
    );
  }
}

async function saveTicketDataFast(channel, ticketData) {
  try {
    await withTimeout(
      saveTicketData(channel.guild.id, channel.id, ticketData),
      DB_TIMEOUT_MS,
      'Ticket database write',
    );
  } catch (error) {
    logger.warn('Ticket database write timed out/failed', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      error: error.message,
    });
    throw ticketError(
      'Ticket database write failed',
      'The ticket database is taking too long to save this change. Please try again.',
    );
  }
}

function isPinnedChannelName(name = '') {
  return String(name).includes(PIN_EMOJI);
}

function getQueuedPinnedState(channel) {
  const queued = channelNameJobs.get(channel.id);
  if (queued?.desiredPinned !== null && queued?.desiredPinned !== undefined) {
    return Boolean(queued.desiredPinned);
  }
  return isPinnedChannelName(channel.name);
}

function getCleanTicketChannelName(name = '') {
  const decorations = [
    PIN_EMOJI,
    ...new Set(Object.values(PRIORITY_MAP).map(info => info?.emoji).filter(Boolean)),
  ];

  let cleanName = String(name);
  for (const decoration of decorations) {
    cleanName = cleanName.replaceAll(decoration, '');
  }

  cleanName = cleanName
    .replace(/^[\s-]+|[\s-]+$/g, '')
    .replace(/[\s-]+/g, '-');

  const ticketMatch = cleanName.match(/ticket-\d+/i);
  return ticketMatch?.[0]?.toLowerCase() || cleanName || 'ticket';
}

function getDesiredTicketChannelName(currentName, priority, pinned) {
  const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
  const parts = [];

  if (priority !== 'none' && priorityInfo?.emoji) {
    parts.push(priorityInfo.emoji);
  }
  if (pinned) {
    parts.push(PIN_EMOJI);
  }

  parts.push(getCleanTicketChannelName(currentName));
  return parts.join('-');
}

function getRetryDelayMs(error) {
  const values = [
    error?.retry_after,
    error?.retryAfter,
    error?.data?.retry_after,
    error?.rawError?.retry_after,
    error?.response?.data?.retry_after,
  ];

  for (const value of values) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000) + 250;
    }
  }

  return CHANNEL_NAME_RETRY_MS;
}

function scheduleTicketChannelNameSync(channel, updates = {}) {
  if (!channel?.id || !channel?.guild?.id) return;

  const key = channel.id;
  const existing = channelNameJobs.get(key) || {
    channel,
    desiredPriority: null,
    desiredPinned: null,
    running: false,
    timer: null,
  };

  existing.channel = channel;
  if (updates.priority !== undefined) {
    existing.desiredPriority = String(updates.priority || 'none').toLowerCase();
  }
  if (updates.pinned !== undefined) {
    existing.desiredPinned = Boolean(updates.pinned);
  }
  channelNameJobs.set(key, existing);

  if (existing.running || existing.timer) return;

  const run = async () => {
    const job = channelNameJobs.get(key);
    if (!job || job.running) return;

    job.timer = null;
    job.running = true;

    try {
      const storedTicket = await withTimeout(
        getTicketData(job.channel.guild.id, key),
        DB_TIMEOUT_MS,
        'Ticket rename state read',
      ).catch(() => null);

      const snapshotPriority = job.desiredPriority
        ?? String(storedTicket?.priority || 'none').toLowerCase();
      const snapshotPinned = job.desiredPinned ?? isPinnedChannelName(job.channel.name);
      const desiredName = getDesiredTicketChannelName(
        job.channel.name,
        snapshotPriority,
        snapshotPinned,
      );

      if (desiredName !== job.channel.name) {
        const renamedChannel = await job.channel.setName(
          desiredName,
          `Synchronize ticket priority/status (${snapshotPriority})`,
        );
        if (renamedChannel) job.channel = renamedChannel;
      }

      const hasNewerState =
        (job.desiredPriority ?? snapshotPriority) !== snapshotPriority
        || (job.desiredPinned ?? snapshotPinned) !== snapshotPinned;

      job.running = false;

      if (hasNewerState) {
        queueMicrotask(run);
        return;
      }

      channelNameJobs.delete(key);
    } catch (error) {
      job.running = false;

      if ([10003, 10008].includes(error?.code)) {
        channelNameJobs.delete(key);
        return;
      }

      const retryMs = getRetryDelayMs(error);
      logger.warn('Ticket channel status rename delayed by Discord; retrying latest state', {
        guildId: job.channel?.guild?.id,
        channelId: key,
        desiredPriority: job.desiredPriority,
        desiredPinned: job.desiredPinned,
        retryMs,
        error: error.message,
      });

      job.timer = setTimeout(run, retryMs);
      job.timer.unref?.();
    }
  };

  queueMicrotask(run);
}

export function buildCloudyTicketControls({ claimedBy = null } = {}) {
  const claimButton = claimedBy
    ? new ButtonBuilder()
      .setCustomId('ticket_unclaim')
      .setLabel('Unclaim')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔓')
    : new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Claim')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('✋');

  return new ActionRowBuilder().addComponents(
    claimButton,
    new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel('Pin')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(PIN_EMOJI),
    new ButtonBuilder()
      .setCustomId('ticket_priority_menu')
      .setLabel('Priority')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🟡'),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

function toDiscordTimestamp(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ms)) return 'Unknown';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function buildTicketFields(ticketData) {
  const status = String(ticketData.status || 'open').toLowerCase();
  return [
    {
      name: 'Status',
      value: status === 'closed' ? '🔴 Closed' : '🟢 Open',
      inline: true,
    },
    {
      name: 'Claimed By',
      value: ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : 'Not claimed',
      inline: true,
    },
    {
      name: 'Created',
      value: toDiscordTimestamp(ticketData.createdAt),
      inline: true,
    },
  ];
}

function isMainTicketMessage(message, channel) {
  return Boolean(
    message?.author?.id === channel.client.user?.id
    && message.embeds?.[0]?.title?.startsWith('Ticket #'),
  );
}

async function findMainTicketMessage(channel, ticketData) {
  if (ticketData?.ticketMessageId) {
    const direct = await withTimeout(
      channel.messages.fetch(ticketData.ticketMessageId),
      DISCORD_TIMEOUT_MS,
      'Ticket message direct fetch',
    ).catch(() => null);
    if (isMainTicketMessage(direct, channel)) return direct;
  }

  if (typeof channel.messages?.fetchPins === 'function') {
    const pinnedResponse = await withTimeout(
      channel.messages.fetchPins(),
      DISCORD_TIMEOUT_MS,
      'Pinned ticket message fetch',
    ).catch(() => null);
    const pinnedTicket = pinnedResponse?.items?.find(message => isMainTicketMessage(message, channel));
    if (pinnedTicket) return pinnedTicket;
  } else if (typeof channel.messages?.fetchPinned === 'function') {
    const pinned = await withTimeout(
      channel.messages.fetchPinned(),
      DISCORD_TIMEOUT_MS,
      'Pinned ticket message fetch',
    ).catch(() => null);
    const pinnedTicket = pinned?.find(message => isMainTicketMessage(message, channel));
    if (pinnedTicket) return pinnedTicket;
  }

  const recent = await withTimeout(
    channel.messages.fetch({ limit: 100 }),
    DISCORD_TIMEOUT_MS,
    'Recent ticket message fetch',
  ).catch(() => null);

  return recent?.find(message => isMainTicketMessage(message, channel)) || null;
}

export async function syncCloudyTicketMessage(channel) {
  try {
    const ticketData = await getTicketDataFast(channel);
    if (!ticketData) return false;

    const ticketMessage = await findMainTicketMessage(channel, ticketData);
    if (!ticketMessage) {
      logger.warn('Could not locate main ticket message', {
        guildId: channel.guild.id,
        channelId: channel.id,
      });
      return false;
    }

    if (!ticketData.ticketMessageId) {
      ticketData.ticketMessageId = ticketMessage.id;
      await saveTicketDataFast(channel, ticketData).catch(() => {});
    }

    const currentEmbed = ticketMessage.embeds[0];
    const priorityInfo = PRIORITY_MAP[ticketData.priority || 'none'] || PRIORITY_MAP.none;
    const ticketOwner = `<@${ticketData.userId}>`;
    const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';

    const updatedEmbed = createEmbed({
      title: currentEmbed.title || 'Ticket',
      description:
        `${ticketOwner}, ${TICKET_RECEIVED_MESSAGE}`
        + `\n\n**Reason:** ${ticketData.reason || 'No reason provided'}`
        + `\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: isClosed ? '#e74c3c' : priorityInfo.color,
      fields: buildTicketFields(ticketData),
      footer: currentEmbed.footer,
    });

    await withTimeout(
      ticketMessage.edit({
        embeds: [updatedEmbed],
        components: isClosed ? [] : [buildCloudyTicketControls({ claimedBy: ticketData.claimedBy })],
      }),
      DISCORD_TIMEOUT_MS,
      'Ticket message edit',
    );

    return true;
  } catch (error) {
    logger.warn('Could not sync Cloudy ticket UI', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      error: error.message,
    });
    return false;
  }
}

export async function syncCloudyTicketChannelName(channel) {
  const ticketData = await withTimeout(
    getTicketData(channel.guild.id, channel.id),
    DB_TIMEOUT_MS,
    'Ticket channel-name state read',
  ).catch(() => null);
  if (!ticketData) return false;

  scheduleTicketChannelNameSync(channel, {
    priority: String(ticketData.priority || 'none').toLowerCase(),
    pinned: getQueuedPinnedState(channel),
  });
  return true;
}

export async function setTicketPinned(channel, pinned) {
  const ticketData = await getTicketDataFast(channel);
  if (!ticketData) {
    throw ticketError(
      'Ticket data not found',
      'This action can only be used in a valid ticket channel.',
    );
  }

  scheduleTicketChannelNameSync(channel, {
    priority: String(ticketData.priority || 'none').toLowerCase(),
    pinned: Boolean(pinned),
  });
  return Boolean(pinned);
}

export async function createTicket(...args) {
  const result = await withTimeout(
    createTicketBase(...args),
    10_000,
    'Ticket creation',
  );

  await syncCloudyTicketMessage(result.channel);
  await syncCloudyTicketChannelName(result.channel);
  return result;
}

export async function claimTicket(channel, claimer) {
  const ticketData = await getTicketDataFast(channel);
  if (!ticketData) {
    throw ticketError('Ticket data not found', 'This is not a valid ticket channel.');
  }
  if (String(ticketData.status || 'open').toLowerCase() === 'closed') {
    throw ticketError('Ticket is closed', 'This ticket is already closed.');
  }
  if (ticketData.claimedBy && String(ticketData.claimedBy) !== String(claimer.id)) {
    throw ticketError(
      'Ticket already claimed',
      `This ticket is already claimed by <@${ticketData.claimedBy}>.`,
    );
  }
  if (String(ticketData.claimedBy || '') === String(claimer.id)) {
    await syncCloudyTicketMessage(channel);
    return ticketData;
  }

  ticketData.claimedBy = claimer.id;
  ticketData.claimedAt = new Date().toISOString();
  await saveTicketDataFast(channel, ticketData);
  await syncCloudyTicketMessage(channel);

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

    const overwrite = channel.permissionOverwrites.cache.get(ticketData.userId);
    if (overwrite) {
      await overwrite.edit({ ViewChannel: false, SendMessages: false }).catch(() => {});
    } else {
      await channel.permissionOverwrites.create(ticketData.userId, {
        ViewChannel: false,
        SendMessages: false,
      }).catch(() => {});
    }
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
    title: 'Ticket Closed',
    description: `This ticket has been closed by ${closer}.\n**Reason:** ${reason}`,
    color: '#e74c3c',
    footer: { text: `Ticket #${ticketNumberOf(ticketData)}` },
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
    channel.send({ embeds: [closeEmbed], components: [controlRow] }),
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
    result = await withTimeout(
      reopenTicketBase(channel, reopener),
      7000,
      'Ticket reopen',
    );
  } finally {
    await syncCloudyTicketMessage(channel);
    await syncCloudyTicketChannelName(channel);
  }
  return result;
}

export async function updateTicketPriority(channel, priority, updater) {
  const priorityInfo = PRIORITY_MAP[priority];
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

  const previousPriority = String(ticketData.priority || 'none').toLowerCase();
  ticketData.priority = priority;
  ticketData.priorityUpdatedBy = updater.id;
  ticketData.priorityUpdatedAt = new Date().toISOString();

  await saveTicketDataFast(channel, ticketData);
  scheduleTicketChannelNameSync(channel, {
    priority,
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
      priority,
      metadata: { previousPriority, priority },
    },
  }).catch(() => {});

  logger.info('Ticket priority updated', {
    guildId: channel.guild.id,
    channelId: channel.id,
    previousPriority,
    priority,
    updaterId: updater.id,
  });

  return ticketData;
}

export {
  deleteTicket,
  getUserTicketCount,
};
