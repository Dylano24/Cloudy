import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_TICKET_FOOTER } from '../utils/ticket/ticketBranding.js';

const PIN_EMOJI = '📌';
const renderQueues = new Map();
const RECEIVED_INTRO = 'we’ve received your request!';
const RECEIVED_DETAILS =
  'To help us process your ticket as quickly as possible, please provide any additional details you believe may be useful, along with any screenshots or files that could help us better understand your situation.';
const STAFF_NOTICE =
  '**Please do not tag or spam our staff members for updates.** We can see your messages and have received all the information you’ve provided. If you don’t receive an immediate response, it simply means that we may be busy elsewhere or handling other requests.';
const PATIENCE_NOTICE =
  'Please be patient and allow us some time to review your ticket and get back to you.';
const UNDERSTANDING_NOTICE = 'We appreciate your understanding!';

function ticketNumber(ticketData, fallbackTitle = '') {
  const titleMatch = String(fallbackTitle).match(/Ticket\s*#\s*0*(\d+)/i);
  if (titleMatch) return String(Number.parseInt(titleMatch[1], 10));
  const parsed = Number.parseInt(String(ticketData?.ticketNumber || ticketData?.id || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : 'Unknown';
}

function isLiveChannel(channel) {
  if (!channel?.guild?.id || !channel?.id || channel.deleted === true) return false;
  return channel.guild.channels.cache.has(channel.id);
}

function enqueueRender(channel, operation) {
  const key = `${channel.guild.id}:${channel.id}`;
  const previous = renderQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  renderQueues.set(key, current);
  current.finally(() => {
    if (renderQueues.get(key) === current) renderQueues.delete(key);
  }).catch(() => {});
  return current;
}

function makeClaimButton(ticketData) {
  return ticketData.claimedBy
    ? new ButtonBuilder()
      .setCustomId('ticket_unclaim')
      .setLabel('Unclaim')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔓')
    : new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Claim')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✋🏽');
}

function makeTicketActionRow(ticketData) {
  return new ActionRowBuilder().addComponents(
    makeClaimButton(ticketData),
    new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel('Pin')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(PIN_EMOJI),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

function buildTicketEmbed(ticketData, number) {
  const reason = String(ticketData.reason || 'No reason provided').slice(0, 1024);

  return new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle(`Ticket #${number}`)
    .setDescription(
      `<@${ticketData.userId}>, ${RECEIVED_INTRO}`
      + `\n\n${RECEIVED_DETAILS}`
      + `\n\n${STAFF_NOTICE}`
      + `\n\n${PATIENCE_NOTICE}`
      + `\n\n${UNDERSTANDING_NOTICE}`
      + `\n\n**Reason:** ${reason}`,
    )
    .setFooter({ text: CLOUDY_TICKET_FOOTER });
}

async function findMainTicketMessage(channel, ticketData, preferredMessage = null) {
  if (!isLiveChannel(channel)) return null;

  if (preferredMessage?.author?.id === channel.client.user?.id && preferredMessage.editable) {
    return preferredMessage;
  }

  if (ticketData?.ticketMessageId) {
    const direct = await channel.messages.fetch(ticketData.ticketMessageId).catch(() => null);
    if (direct?.author?.id === channel.client.user?.id) return direct;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return null;

  return recent.find(message => {
    if (message.author?.id !== channel.client.user?.id) return false;
    if (message.embeds?.[0]?.title?.startsWith('Ticket #')) return true;
    try {
      const serialized = JSON.stringify(
        message.components?.map(component => component.toJSON?.() ?? component) || [],
      );
      return serialized.includes('Ticket #');
    } catch {
      return false;
    }
  }) || null;
}

async function replaceComponentsV2TicketMessage(channel, message, ticketData, embed, components) {
  const wasPinned = message.pinned === true;
  const replacement = await channel.send({
    embeds: [embed],
    components,
    allowedMentions: { parse: [] },
  });

  if (wasPinned) {
    await replacement.pin().catch(() => {});
  }

  ticketData.ticketMessageId = replacement.id;
  await saveTicketData(channel.guild.id, channel.id, ticketData);
  await message.delete().catch(() => {});

  return replacement;
}

export async function renderTicketV2(channel, preferredMessage = null) {
  if (!isLiveChannel(channel)) return false;

  return enqueueRender(channel, async () => {
    try {
      if (!isLiveChannel(channel)) return false;

      const ticketData = await getTicketData(channel.guild.id, channel.id).catch(() => null);
      if (!ticketData || String(ticketData.status || '').toLowerCase() === 'deleted') return false;

      const message = await findMainTicketMessage(channel, ticketData, preferredMessage);
      if (!message || !isLiveChannel(channel)) return false;

      const number = ticketNumber(ticketData, message.embeds?.[0]?.title || '');
      if (number !== 'Unknown') ticketData.ticketNumber = number;

      const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
      const embed = buildTicketEmbed(ticketData, number);
      const components = isClosed ? [] : [makeTicketActionRow(ticketData)];

      if (message.flags?.has?.(MessageFlags.IsComponentsV2)) {
        await replaceComponentsV2TicketMessage(channel, message, ticketData, embed, components);
        return true;
      }

      if (!message.editable) return false;

      if (!ticketData.ticketMessageId || ticketData.ticketMessageId !== message.id) {
        ticketData.ticketMessageId = message.id;
        await saveTicketData(channel.guild.id, channel.id, ticketData).catch(() => {});
      }

      await message.edit({
        content: null,
        embeds: [embed],
        components,
      });

      return true;
    } catch (error) {
      if (isLiveChannel(channel)) {
        logger.warn(`Could not render Cloudy ticket layout: ${error.message}`, {
          guildId: channel?.guild?.id,
          channelId: channel?.id,
        });
      }
      return false;
    }
  });
}
