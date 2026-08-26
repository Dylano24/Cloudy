import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { CLOUDY_TICKET_FOOTER } from '../utils/ticket/ticketBranding.js';

const PIN_EMOJI = '📌';
const renderQueues = new Map();
const RECEIVED_INTRO = 'we’ve received your request!';
const RECEIVED_DETAILS_START =
  'To help us process it as quickly as possible, feel free to provide any additional details';
const RECEIVED_DETAILS_END =
  'you think may be useful, as well as any screenshots or files that could help us better\nunderstand your situation.';
const RECEIVED_CLOSING = 'Our team will be with you as soon as possible.';
const SINGLE_LINE_CLOUDY_FOOTER = CLOUDY_TICKET_FOOTER.replaceAll(' ', '\u202F');

function ticketNumber(ticketData, fallbackTitle = '') {
  const titleMatch = String(fallbackTitle).match(/Ticket\s*#\s*0*(\d+)/i);
  if (titleMatch) return String(Number.parseInt(titleMatch[1], 10));
  const parsed = Number.parseInt(String(ticketData?.ticketNumber || ticketData?.id || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : 'Unknown';
}

function relativeTimestamp(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ms)) return 'Unknown';
  return `<t:${Math.floor(ms / 1000)}:R>`;
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

function buildContainer(ticketData, number, logoUrl = null) {
  const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
  const claimedBy = ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : 'Not claimed';

  const headerParts = [
    new TextDisplayBuilder().setContent(
      `## Ticket #${number}\n<@${ticketData.userId}>, ${RECEIVED_INTRO}`,
    ),
    new TextDisplayBuilder().setContent(
      `${RECEIVED_DETAILS_START} ${RECEIVED_DETAILS_END}`,
    ),
  ];

  const container = new ContainerBuilder()
    .setAccentColor(0xFFFFFF);

  if (logoUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(...headerParts)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(logoUrl)),
    );
  } else {
    container.addTextDisplayComponents(...headerParts);
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(RECEIVED_CLOSING),
    new TextDisplayBuilder().setContent(
      `**Reason:** ${ticketData.reason || 'No reason provided'}`,
    ),
    new TextDisplayBuilder().setContent(
      `**Status**\n${isClosed ? 'Closed' : 'Open'}`,
    ),
    new TextDisplayBuilder().setContent(
      `**Claimed By**\n${claimedBy}`,
    ),
    new TextDisplayBuilder().setContent(
      `**Created**\n${relativeTimestamp(ticketData.createdAt)}`,
    ),
    new TextDisplayBuilder().setContent(SINGLE_LINE_CLOUDY_FOOTER),
  );

  return container;
}

async function findMainTicketMessage(channel, ticketData, preferredMessage = null) {
  if (!isLiveChannel(channel)) return null;

  if (preferredMessage?.author?.id === channel.client.user?.id && preferredMessage.editable) {
    return preferredMessage;
  }

  if (ticketData?.ticketMessageId) {
    const direct = await channel.messages.fetch(ticketData.ticketMessageId).catch(() => null);
    if (direct?.editable) return direct;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return null;

  return recent.find(message => {
    if (message.author?.id !== channel.client.user?.id || !message.editable) return false;
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

export async function renderTicketV2(channel, preferredMessage = null) {
  if (!isLiveChannel(channel)) return false;

  return enqueueRender(channel, async () => {
    try {
      if (!isLiveChannel(channel)) return false;

      const ticketData = await getTicketData(channel.guild.id, channel.id).catch(() => null);
      if (!ticketData || String(ticketData.status || '').toLowerCase() === 'deleted') return false;

      const message = await findMainTicketMessage(channel, ticketData, preferredMessage);
      if (!message || !message.editable || !isLiveChannel(channel)) return false;

      const number = ticketNumber(ticketData, message.embeds?.[0]?.title || '');
      if (!ticketData.ticketMessageId || ticketData.ticketMessageId !== message.id) {
        ticketData.ticketMessageId = message.id;
        if (number !== 'Unknown') ticketData.ticketNumber = number;
        await saveTicketData(channel.guild.id, channel.id, ticketData).catch(() => {});
      }

      const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
      const logoUrl = channel.client.user?.displayAvatarURL?.({ extension: 'png', size: 256 }) || null;
      const container = buildContainer(ticketData, number, logoUrl);
      const components = isClosed
        ? [container]
        : [container, makeTicketActionRow(ticketData)];

      const fresh = await channel.messages.fetch(message.id).catch(() => message);
      if (!fresh?.editable || !isLiveChannel(channel)) return false;

      await fresh.edit({
        content: null,
        embeds: [],
        components,
        flags: MessageFlags.IsComponentsV2,
      });

      return true;
    } catch (error) {
      if (isLiveChannel(channel)) {
        logger.warn(`Could not render Cloudy ticket Components V2 layout: ${error.message}`, {
          guildId: channel?.guild?.id,
          channelId: channel?.id,
        });
      }
      return false;
    }
  });
}
