// ticketPermissions.js

import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';
import { getTicketData, saveTicketData } from '../database.js';
import { logger } from '../logger.js';

const TICKET_IO_TIMEOUT_MS = 1800;

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

function isCloudyTicketMessage(message, botId) {
  return Boolean(
    message?.author?.id === botId
    && message.embeds?.some(embed => embed.title?.startsWith('Ticket #')),
  );
}

async function findTicketMessage(channel, botId) {
  if (typeof channel.messages?.fetchPinned === 'function') {
    const pinned = await withTimeout(
      channel.messages.fetchPinned(),
      TICKET_IO_TIMEOUT_MS,
      'Pinned ticket message lookup',
    ).catch(() => null);

    const pinnedTicket = pinned?.find(message => isCloudyTicketMessage(message, botId));
    if (pinnedTicket) return pinnedTicket;
  }

  const recent = await withTimeout(
    channel.messages.fetch({ limit: 100 }),
    TICKET_IO_TIMEOUT_MS,
    'Recent ticket message lookup',
  ).catch(() => null);

  return recent?.find(message => isCloudyTicketMessage(message, botId)) || null;
}

async function recoverTicketDataFromChannel(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;

  if (!guild || !channel?.isTextBased?.() || !channel.messages?.fetch) {
    return null;
  }

  const ticketMessage = await findTicketMessage(channel, interaction.client.user?.id);
  if (!ticketMessage) return null;

  const embed = ticketMessage.embeds.find(item => item.title?.startsWith('Ticket #'));
  const creatorId =
    extractMentionedUserId(ticketMessage.content)
    || extractMentionedUserId(embed?.description);

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
    ticketMessageId: ticketMessage.id,
    createdAt: ticketMessage.createdAt?.toISOString?.() || new Date().toISOString(),
    status: /closed/i.test(statusField) ? 'closed' : 'open',
    claimedBy,
    priority: extractPriority(embed?.description),
    reason: extractReason(embed?.description),
    recoveredFromDiscord: true,
  };

  // Do not let a slow database block the interaction. Recovery is already
  // valid for the current click; persistence is best-effort and bounded.
  void withTimeout(
    saveTicketData(guild.id, channel.id, recovered),
    TICKET_IO_TIMEOUT_MS,
    'Recovered ticket save',
  ).catch(error => {
    logger.warn('Could not persist recovered ticket data quickly', {
      guildId: guild.id,
      channelId: channel.id,
      error: error.message,
    });
  });

  return recovered;
}

export async function getTicketPermissionContext({ client, interaction }) {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const configPromise = withTimeout(
    getGuildConfig(client, guildId),
    TICKET_IO_TIMEOUT_MS,
    'Ticket guild config lookup',
  ).catch(error => {
    logger.warn('Ticket guild config lookup timed out/failed', {
      guildId,
      channelId,
      error: error.message,
    });
    return {};
  });

  let ticketData = await withTimeout(
    getTicketData(guildId, channelId),
    TICKET_IO_TIMEOUT_MS,
    'Ticket database lookup',
  ).catch(error => {
    logger.warn('Ticket database lookup timed out/failed', {
      guildId,
      channelId,
      error: error.message,
    });
    return null;
  });

  if (!ticketData) {
    ticketData = await recoverTicketDataFromChannel(interaction);
  }

  const config = await configPromise;
  const hasManageChannels = Boolean(
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels),
  );
  const staffRoleId = config?.ticketStaffRoleId || null;
  const hasTicketStaffRole = Boolean(
    staffRoleId && interaction.member?.roles?.cache?.has?.(staffRoleId),
  );
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
