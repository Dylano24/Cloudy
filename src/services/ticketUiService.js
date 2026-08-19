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

// One non-blocking rename worker per ticket channel. Discord rate-limits channel
// name changes aggressively. The worker always converges to the LATEST priority
// instead of making the interaction wait or giving up after one failed rename.
const priorityRenameJobs = new Map();
const PRIORITY_RENAME_RETRY_MS = 15_000;

function getCleanTicketChannelName(name = '') {
  const emojis = [...new Set(Object.values(PRIORITY_MAP).map(info => info.emoji).filter(Boolean))];
  let cleanName = String(name);
  for (const emoji of emojis) cleanName = cleanName.replaceAll(emoji, '');
  return cleanName.replace(/^[-\s]+/, '').trim() || 'ticket';
}

function getPriorityChannelName(currentName, priority) {
  const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;
  const cleanName = getCleanTicketChannelName(currentName);
  return priority === 'none' ? cleanName : `${priorityInfo.emoji}-${cleanName}`;
}

function schedulePriorityChannelRename(channel, priority) {
  const key = channel.id;
  const existing = priorityRenameJobs.get(key) || {
    channel,
    desiredPriority: priority,
    running: false,
    timer: null,
  };

  existing.channel = channel;
  existing.desiredPriority = priority;
  priorityRenameJobs.set(key, existing);

  if (existing.running || existing.timer) return;

  const run = async () => {
    const job = priorityRenameJobs.get(key);
    if (!job) return;

    job.timer = null;
    job.running = true;

    try {
      const latestPriority = job.desiredPriority;
      const desiredName = getPriorityChannelName(job.channel.name, latestPriority);

      if (desiredName !== job.channel.name) {
        await job.channel.setName(desiredName, `Ticket priority changed to ${latestPriority}`);
      }

      // A newer priority may have been selected while Discord was waiting on
      // its rename rate limit. If so, immediately process the newest value.
      if (job.desiredPriority !== latestPriority) {
        job.running = false;
        queueMicrotask(run);
        return;
      }

      priorityRenameJobs.delete(key);
    } catch (error) {
      job.running = false;

      // If the channel was deleted or is otherwise gone, stop retrying.
      if ([10003, 10008].includes(error?.code)) {
        priorityRenameJobs.delete(key);
        return;
      }

      logger.warn('Ticket priority status emoji rename delayed; retrying', {
        channelId: key,
        desiredPriority: job.desiredPriority,
        error: error.message,
      });

      job.timer = setTimeout(run, PRIORITY_RENAME_RETRY_MS);
      job.timer.unref?.();
      return;
    }

    const jobAfter = priorityRenameJobs.get(key);
    if (jobAfter) jobAfter.running = false;
  };

  queueMicrotask(run);
}

export function buildCloudyTicketControls({ claimedBy = null } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel(claimedBy ? 'Claimed' : 'Claim').setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary).setEmoji('✋').setDisabled(Boolean(claimedBy)),
    new ButtonBuilder().setCustomId('ticket_pin').setLabel('Pin').setStyle(ButtonStyle.Secondary).setEmoji('📌'),
    new ButtonBuilder().setCustomId('ticket_priority_menu').setLabel('Priority').setStyle(ButtonStyle.Secondary).setEmoji('🟡'),
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
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
    { name: 'Status', value: status === 'closed' ? '🔴 Closed' : '🟢 Open', inline: true },
    { name: 'Claimed By', value: ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : 'Not claimed', inline: true },
    { name: 'Created', value: toDiscordTimestamp(ticketData.createdAt), inline: true },
  ];
}

export async function syncCloudyTicketMessage(channel) {
  try {
    const ticketData = await getTicketData(channel.guild.id, channel.id);
    if (!ticketData) return false;
    const messages = await channel.messages.fetch({ limit: 100 });
    const ticketMessage = messages.find(message => message.author?.id === channel.client.user?.id && message.embeds?.[0]?.title?.startsWith('Ticket #'));
    if (!ticketMessage) return false;
    const currentEmbed = ticketMessage.embeds[0];
    const priorityInfo = PRIORITY_MAP[ticketData.priority || 'none'] || PRIORITY_MAP.none;
    const ticketOwner = `<@${ticketData.userId}>`;
    const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
    const updatedEmbed = createEmbed({
      title: currentEmbed.title || 'Ticket',
      description: `${ticketOwner}, ${TICKET_RECEIVED_MESSAGE}\n\n**Reason:** ${ticketData.reason || 'No reason provided'}\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: isClosed ? '#e74c3c' : priorityInfo.color,
      fields: buildTicketFields(ticketData),
      footer: currentEmbed.footer,
    });
    await ticketMessage.edit({ embeds: [updatedEmbed], components: isClosed ? [] : [buildCloudyTicketControls({ claimedBy: ticketData.claimedBy })] });
    return true;
  } catch (error) {
    logger.warn('Could not sync Cloudy ticket UI', { guildId: channel?.guild?.id, channelId: channel?.id, error: error.message });
    return false;
  }
}

async function runAndAlwaysSync(channel, operation) {
  let result;
  let operationError = null;
  try { result = await operation(); } catch (error) { operationError = error; }
  await syncCloudyTicketMessage(channel);
  if (operationError) throw operationError;
  return result;
}

export async function createTicket(...args) {
  const result = await createTicketBase(...args);
  await syncCloudyTicketMessage(result.channel);
  return result;
}
export async function claimTicket(channel, claimer) { return runAndAlwaysSync(channel, () => claimTicketBase(channel, claimer)); }
export async function unclaimTicket(channel, unclaimer) { return runAndAlwaysSync(channel, () => unclaimTicketBase(channel, unclaimer)); }
export async function reopenTicket(channel, reopener) { return runAndAlwaysSync(channel, () => reopenTicketBase(channel, reopener)); }

export async function updateTicketPriority(channel, priority, updater) {
  const priorityInfo = PRIORITY_MAP[priority];
  if (!priorityInfo) { const error = new Error('Invalid ticket priority.'); error.userMessage = 'Invalid priority selected.'; throw error; }
  const ticketData = await getTicketData(channel.guild.id, channel.id);
  if (!ticketData) { const error = new Error('Ticket data not found.'); error.userMessage = 'This action can only be used in a valid ticket channel.'; throw error; }

  const previousPriority = String(ticketData.priority || 'none').toLowerCase();
  ticketData.priority = priority;
  ticketData.priorityUpdatedBy = updater.id;
  ticketData.priorityUpdatedAt = new Date().toISOString();

  // PostgreSQL is updated first. The visible ticket embed updates immediately.
  // The channel-side emoji is queued separately and keeps retrying until it
  // matches the latest priority, so Discord rename rate limits cannot break it.
  await saveTicketData(channel.guild.id, channel.id, ticketData);
  schedulePriorityChannelRename(channel, priority);
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

export { closeTicket, deleteTicket, getUserTicketCount };
