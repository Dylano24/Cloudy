import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { getTicketData, saveTicketData } from '../utils/database.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const PIN_EMOJI = '📌';
const RECEIVED_MESSAGE =
  'we’ve received your request!\nTo help us process it as quickly as possible, feel free to provide any additional details you think may be useful, as well as any screenshots or files that could help us better understand your situation.\nOur team will be with you as soon as possible.';

function normalizePriority(value) {
  const key = String(value || 'none').toLowerCase();
  if (key === 'urgent') return 'high';
  return PRIORITY_MAP[key] ? key : 'none';
}

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

function buildContainer(ticketData, number) {
  const priorityKey = normalizePriority(ticketData.priority);
  const priorityInfo = PRIORITY_MAP[priorityKey] || PRIORITY_MAP.none;
  const isClosed = String(ticketData.status || 'open').toLowerCase() === 'closed';
  const claimedBy = ticketData.claimedBy ? `<@${ticketData.claimedBy}>` : 'Not claimed';
  const priorityLine = priorityKey !== 'none'
    ? `\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`
    : '';

  const accent = Number.parseInt(
    String(isClosed ? '#FFFFFF' : (priorityInfo.color || '#FFFFFF')).replace('#', ''),
    16,
  );

  const container = new ContainerBuilder()
    .setAccentColor(Number.isFinite(accent) ? accent : 0xFFFFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## Ticket #${number}\n<@${ticketData.userId}>, ${RECEIVED_MESSAGE}`
        + `\n**Reason:** ${ticketData.reason || 'No reason provided'}`
        + priorityLine,
      ),
    );

  if (!isClosed) {
    const priorityButton = new ButtonBuilder()
      .setCustomId('ticket_priority_menu')
      .setLabel('Priority')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🟡');

    const pinButton = new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel('Pin')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(PIN_EMOJI);

    const compactInfo = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**Status** ${isClosed ? 'Closed' : 'Open'}  •  **Claimed By** ${claimedBy}\n**Created** ${relativeTimestamp(ticketData.createdAt)}`,
        ),
      )
      .setButtonAccessory(priorityButton);

    const pinSection = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('‎'),
      )
      .setButtonAccessory(pinButton);

    container
      .addSectionComponents(compactInfo, pinSection)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('© Cloudy Inc. • Quality. Innovation. Performance.'),
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          makeClaimButton(ticketData),
          new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒'),
        ),
      );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Status** Closed  •  **Claimed By** ${claimedBy}  •  **Created** ${relativeTimestamp(ticketData.createdAt)}`,
      ),
      new TextDisplayBuilder().setContent('© Cloudy Inc. • Quality. Innovation. Performance.'),
    );
  }

  return container;
}

async function findMainTicketMessage(channel, ticketData, preferredMessage = null) {
  if (preferredMessage?.author?.id === channel.client.user?.id) return preferredMessage;

  if (ticketData?.ticketMessageId) {
    const direct = await channel.messages.fetch(ticketData.ticketMessageId).catch(() => null);
    if (direct) return direct;
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

export async function renderTicketV2(channel, preferredMessage = null) {
  try {
    if (!channel?.guild?.id) return false;

    const ticketData = await getTicketData(channel.guild.id, channel.id).catch(() => null);
    if (!ticketData) return false;

    const message = await findMainTicketMessage(channel, ticketData, preferredMessage);
    if (!message) return false;

    const number = ticketNumber(ticketData, message.embeds?.[0]?.title || '');
    if (!ticketData.ticketMessageId || ticketData.ticketMessageId !== message.id) {
      ticketData.ticketMessageId = message.id;
      if (number !== 'Unknown') ticketData.ticketNumber = number;
      await saveTicketData(channel.guild.id, channel.id, ticketData).catch(() => {});
    }

    const container = buildContainer(ticketData, number);
    await message.edit({
      content: null,
      embeds: [],
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });

    return true;
  } catch (error) {
    logger.warn('Could not render Cloudy ticket Components V2 layout', {
      guildId: channel?.guild?.id,
      channelId: channel?.id,
      error: error.message,
    });
    return false;
  }
}
