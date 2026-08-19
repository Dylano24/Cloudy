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
      .setEmoji('📌'),
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

async function runAndAlwaysSync(channel, operation) {
  let result;
  let operationError = null;

  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  await syncCloudyTicketMessage(channel);

  if (operationError) throw operationError;
  return result;
}

export async function createTicket(...args) {
  const result = await createTicketBase(...args);
  await syncCloudyTicketMessage(result.channel);
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

  // Priority changes intentionally do NOT rename the Discord channel.
  // Discord heavily rate-limits channel-name edits; repeatedly renaming the
  // ticket was the reason priority changes appeared to stop working after a
  // few attempts. PostgreSQL is the source of truth and the ticket embed is
  // refreshed immediately instead.
  await saveTicketData(channel.guild.id, channel.id, ticketData);
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
