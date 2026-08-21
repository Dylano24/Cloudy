import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import {
  CLOUDY_TICKET_FOOTER,
  forceCloudyTicketFooter,
} from '../utils/ticket/ticketBranding.js';

export const DEFAULT_TICKET_PANEL_MESSAGE = 'Click the button below to create a support ticket.';
export const DEFAULT_TICKET_BUTTON_LABEL = 'Start Chat';
export const TICKET_FAQ_CHANNEL_ID = '1534654577385672917';
export { CLOUDY_TICKET_FOOTER };

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
    .setColor('#FFFFFF');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel(config.ticketButtonLabel || DEFAULT_TICKET_BUTTON_LABEL)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('💬'),
    new ButtonBuilder()
      .setLabel('❔FAQ')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${resolvedGuildId}/${TICKET_FAQ_CHANNEL_ID}`),
  );

  return {
    embeds: [forceCloudyTicketFooter(embed)],
    components: [row],
  };
}
