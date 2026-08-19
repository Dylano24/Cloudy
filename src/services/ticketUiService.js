import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  createTicket as createTicketBase,
  closeTicket,
  claimTicket as claimTicketBase,
  unclaimTicket as unclaimTicketBase,
  reopenTicket as reopenTicketBase,
  deleteTicket,
  getUserTicketCount,
} from './ticket.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { createEmbed } from '../utils/embeds.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const TICKET_RECEIVED_MESSAGE =
  'we’ve received your request!\n\nTo help us process it as quickly as possible, feel free to provide any additional details you think may be useful, as well as any screenshots or files that could help us better understand your situation.\n\nOur team will be with you as soon as possible.';

const PIN_EMOJI = '📌';
const channelNameJobs = new Map();
const CHANNEL_NAME_RETRY_MS = 15_000;

function isPinnedChannelName(name = '') {
  return String(name).includes(PIN_EMOJI);
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

  // Priority remains the left-most status indicator in the Discord channel list.
  if (priority !== 'none' && priorityInfo?.emoji) {
    parts.push(priorityInfo.emoji);
  }

  if (pinned) {
    parts.push(PIN_EMOJI);
  }

  parts.push(getCleanTicketChannelName(currentName));
  return parts.join('-');
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
    if (!job) return;

    job.timer = null;
    job.running = true;

    try {
      const storedTicket = await getTicketData(job.channel.guild.id, key).catch(() => null);
      const snapshotPriority = job.desiredPriority ?? String(storedTicket?.priority || 'none').toLowerCase();
      const snapshotPinned = job.desiredPinned ?? isPinnedChannelName(job.channel.name);
      const desiredName = getDesiredTicketChannelName(job.channel.name, snapshotPriority, snapshotPinned);

      if (desiredName !== job.channel.name) {
        await job.channel.setName(desiredName, `Synchronize ticket priority/status (${snapshotPriority})`);
      }

      // If another click happened while Discord was processing/rate-limiting the
      // rename, immediately continue with the newest requested state.
      if (
        (job.desiredPriority ?? snapshotPriority) !== snapshotPriority
        || (job.desiredPinned ?? snapshotPinned) !== snapshotPinned
      ) {
        job.running = false;
        queueMicrotask(run);
        return;
      }

      channelNameJobs.delete(key);
    } catch (error) {
      job.running = false;

      // Unknown Channel / Unknown Message means there is nothing left to sync.
      if ([10003, 10008].includes(error?.code)) {
        channelNameJobs.delete(key);
        return;
      }

      logger.warn('Ticket channel status rename delayed; retrying', {
        guildId: job.channel?.guild?.id,
        channelId: key,
        desiredPriority: job.desiredPriority,
        desiredPinned: job.desiredPinned,
        error: error.message,
      });

      job.timer = setTimeout(run, CHANNEL_NAME_RETRY_MS);
      job.timer.unref?.();
      return;
    }

    const remainingJob = channelNameJobs.get(key);
    if (remainingJob) remainingJob.running = false;
  };

  queueMicrotask(run);
}

export function buildCloudyTicketControls({ claimedBy = null } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimedBy ? 'Claimed' : 'Claim')
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('✋')
      .setDisabled(Boolean(claimedBy)),
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

export async function syncCloudyTicketMessage(channel) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) return false;

    const messages = await channel.messages.fetch({ limit: 100 });
    const ticketMessage = messages.find(
      message => message.author?.id === channel.client.user?.id
        && message.embeds?.[0]?.title?.startsWith('Ticket #'),
    );
    if (!ticketMessage) return false;

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

    await ticketMessage.edit({
      embeds: [updatedEmbed],
      components: isClosed ? [] : [buildCloudyTicketControls({ claimedBy: ticketData.claimedBy })],
    });

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
  const ticketData = await getTicketData(channel.guild.id, channel.id).catch(() => null);
  if (!ticketData) return false;

  scheduleTicketChannelNameSync(channel, {
    priority: String(ticketData.priority || 'none').toLowerCase(),
    pinned: isPinnedChannelName(channel.name),
  });

  return true;
}

export async function setTicketPinned(channel, pinned) {
  const ticketData = await getTicketData(channel.guild.id, channel.id).catch(() => null);
  if (!ticketData) {
    const error = new Error('Ticket data not found.');
    error.userMessage = 'This action can only be used in a valid ticket channel.';
    throw error;
  }

  scheduleTicketChannelNameSync(channel, {
    priority: String(ticketData.priority || 'none').toLowerCase(),
    pinned: Boolean(pinned),
  });

  return Boolean(pinned);
}

async function runAndAlwaysSync(channel, operation) {
  let result;
  let operationError = null;

  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  await syncCloudyTicketMessage(channel);
  await syncCloudyTicketChannelName(channel);

  if (operationError) throw operationError;
  return result;
}

export async function createTicket(...args) {
  const result = await createTicketBase(...args);
  await syncCloudyTicketMessage(result.channel);
  await syncCloudyTicketChannelName(result.channel);
  return result;
}

export async function claimTicket(channel, claimer) {
  return runAndAlwaysSync(channel, () => claimTicketBase(channel, claimer));
}

export async function unclaimTicket(channel, unclaimer) {
  return runAndAlwaysSync(channel, () => unclaimTicketBase(channel, unclaimer));
}

export async function reopenTicket(channel, reopener) {
  return runAndAlwaysSync(channel, () => reopenTicketBase(channel, reopener));
}

export async function updateTicketPriority(channel, priority, updater) {
  const priorityInfo = PRIORITY_MAP[priority];
  if (!priorityInfo) {
    const error = new Error('Invalid ticket priority.');
    error.userMessage = 'Invalid priority selected.';
    throw error;
  }

  const ticketData = await getTicketData(channel.guild.id, channel.id);
  if (!ticketData) {
    const error = new Error('Ticket data not found.');
    error.userMessage = 'This action can only be used in a valid ticket channel.';
    throw error;
  }

  const previousPriority = String(ticketData.priority || 'none').toLowerCase();
  ticketData.priority = priority;
  ticketData.priorityUpdatedBy = updater.id;
  ticketData.priorityUpdatedAt = new Date().toISOString();

  // PostgreSQL is always the source of truth. The interaction never waits for
  // a channel rename; the channel-name worker keeps retrying independently.
  await saveTicketData(channel.guild.id, channel.id, ticketData);
  scheduleTicketChannelNameSync(channel, {
    priority,
    pinned: isPinnedChannelName(channel.name),
  });
  await syncCloudyTicketMessage(channel);

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
  closeTicket,
  deleteTicket,
  getUserTicketCount,
};
