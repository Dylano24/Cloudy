// ticketPermissions.js

import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { getTicketData, saveTicketData } from '../database.js';
import { logger } from '../logger.js';

function extractMentionedUserId(text = '') {
  return String(text).match(/<@!?(\d+)>/)?.[1] || null;
}

function extractReason(description = '') {
  const match = String(description).match(/\*\*Reason:\*\*\s*([^\n]+)/i);
  return match?.[1]?.trim() || 'Recovered ticket';
}

function extractPriority(description = '') {
  const match = String(description).match(/\*\*Priority:\*\*\s*(?:\S+\s*)?([^\n]+)/i);
  return match?.[1]?.trim()?.toLowerCase() || 'none';
}

async function recoverTicketDataFromChannel(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;

  if (!guild || !channel?.isTextBased?.() || !channel.messages?.fetch) {
    return null;
  }

  // Only recover channels that actually contain Cloudy's ticket control message.
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return null;

  const ticketMessage = messages.find(message =>
    message.author?.id === interaction.client.user?.id &&
    message.embeds?.some(embed => embed.title?.startsWith('Ticket #'))
  );

  if (!ticketMessage) return null;

  const embed = ticketMessage.embeds.find(item => item.title?.startsWith('Ticket #'));
  const creatorId =
    extractMentionedUserId(ticketMessage.content) ||
    extractMentionedUserId(embed?.description);

  if (!creatorId) {
    logger.warn('Could not recover ticket creator from existing ticket message', {
      guildId: guild.id,
      channelId: channel.id,
      messageId: ticketMessage.id,
    });
    return null;
  }

  const statusField = embed?.fields?.find(field => field.name === 'Status')?.value || '';
  const claimedField = embed?.fields?.find(field => field.name === 'Claimed By')?.value || '';
  const claimedBy = /not claimed/i.test(claimedField)
    ? null
    : extractMentionedUserId(claimedField);

  const recovered = {
    id: channel.id,
    userId: creatorId,
    guildId: guild.id,
    createdAt: ticketMessage.createdAt?.toISOString?.() || new Date().toISOString(),
    status: /closed/i.test(statusField) ? 'closed' : 'open',
    claimedBy,
    priority: extractPriority(embed?.description),
    reason: extractReason(embed?.description),
    recoveredFromDiscord: true,
  };

  await saveTicketData(guild.id, channel.id, recovered);

  logger.info('Recovered missing ticket data from Discord channel', {
    guildId: guild.id,
    channelId: channel.id,
    userId: creatorId,
    claimedBy,
  });

  return recovered;
}

export async function getTicketPermissionContext({ client, interaction }) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const configPromise = getGuildConfig(client, guildId);
  let ticketData = await getTicketData(guildId, channelId);

  // Tickets created before the PostgreSQL migration can still exist in Discord
  // while the new database has no row for them. Recover them automatically.
  if (!ticketData) {
    ticketData = await recoverTicketDataFromChannel(interaction);
  }

  const config = await configPromise;

  const hasManageChannels = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
  const staffRoleId = config.ticketStaffRoleId || null;
  const hasTicketStaffRole = Boolean(staffRoleId && interaction.member.roles?.cache?.has(staffRoleId));
  const isTicketCreator = Boolean(
    ticketData?.userId && String(ticketData.userId) === String(interaction.user.id),
  );

  return {
    config,
    ticketData,
    hasManageChannels,
    hasTicketStaffRole,
    isTicketCreator,
    canManageTicket: hasManageChannels || hasTicketStaffRole,
    canCloseTicket: hasManageChannels || hasTicketStaffRole || isTicketCreator,
  };
}
