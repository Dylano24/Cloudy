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
  updateTicketPriority as updateTicketPriorityBase,
  getUserTicketCount,
} from './ticket.js';
import { getTicketData } from '../utils/database.js';
import { createEmbed } from '../utils/embeds.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export const TICKET_RECEIVED_MESSAGE =
  'we’ve received your request! To help us process it as quickly as possible, feel free to provide any additional details you think may be useful, as well as any screenshots or files that could help us better understand your situation. Our team will be with you as soon as possible.';

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

    const updatedEmbed = createEmbed({
      title: currentEmbed.title || 'Ticket',
      description:
        `${ticketOwner}, ${TICKET_RECEIVED_MESSAGE}`
        + `\n\n**Reason:** ${ticketData.reason || 'No reason provided'}`
        + `\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
      color: priorityInfo.color,
      fields: currentEmbed.fields || [],
      footer: currentEmbed.footer,
    });

    await ticketMessage.edit({
      embeds: [updatedEmbed],
      components: [buildCloudyTicketControls({ claimedBy: ticketData.claimedBy })],
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

export async function createTicket(...args) {
  const result = await createTicketBase(...args);
  await syncCloudyTicketMessage(result.channel);
  return result;
}

export async function claimTicket(channel, claimer) {
  const result = await claimTicketBase(channel, claimer);
  await syncCloudyTicketMessage(channel);
  return result;
}

export async function unclaimTicket(channel, unclaimer) {
  const result = await unclaimTicketBase(channel, unclaimer);
  await syncCloudyTicketMessage(channel);
  return result;
}

export async function reopenTicket(channel, reopener) {
  const result = await reopenTicketBase(channel, reopener);
  await syncCloudyTicketMessage(channel);
  return result;
}

export async function updateTicketPriority(channel, priority, updater) {
  const result = await updateTicketPriorityBase(channel, priority, updater);
  await syncCloudyTicketMessage(channel);
  return result;
}

export {
  closeTicket,
  deleteTicket,
  getUserTicketCount,
};
