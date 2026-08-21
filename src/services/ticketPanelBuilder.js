import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export const DEFAULT_TICKET_PANEL_MESSAGE = 'Click the button below to create a support ticket.';
export const DEFAULT_TICKET_BUTTON_LABEL = 'Start Chat';
export const TICKET_FAQ_CHANNEL_ID = '1534654577385672917';
export const CLOUDY_TICKET_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

function resolveGuildId(client, guildId = null) {
  if (guildId) return guildId;
  const faqChannel = client?.channels?.cache?.get?.(TICKET_FAQ_CHANNEL_ID);
  if (faqChannel?.guildId) return faqChannel.guildId;
  return client?.guilds?.cache?.first?.()?.id || '@me';
}

export function buildTicketPanelPayload(client, guildId, config = {}) {
  const resolvedGuildId = resolveGuildId(client, guildId);

  const embed = new EmbedBuilder()
    .setTitle('Contact the support')
    .setDescription(config.ticketPanelMessage || DEFAULT_TICKET_PANEL_MESSAGE)
    .setColor('#FFFFFF')
    .setFooter({ text: CLOUDY_TICKET_FOOTER });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel(config.ticketButtonLabel || DEFAULT_TICKET_BUTTON_LABEL)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('💬'),
    new ButtonBuilder()
      .setLabel('FAQ')
      .setStyle(ButtonStyle.Link)
      .setEmoji('❔')
      .setURL(`https://discord.com/channels/${resolvedGuildId}/${TICKET_FAQ_CHANNEL_ID}`),
  );

  return {
    embeds: [embed],
    components: [row],
  };
}
