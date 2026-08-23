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

export const DEFAULT_TICKET_PANEL_MESSAGE = `If you need assistance or have something to report, simply hit the **Start Chat** button below and our team will get back to you as soon as possible.

Before submitting a request, please make sure the answer to your question cannot already be found in our **FAQ** section using the button at the bottom right.`;
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
  const panelMessage = typeof config.ticketPanelMessage === 'string' && config.ticketPanelMessage.trim()
    ? config.ticketPanelMessage
    : DEFAULT_TICKET_PANEL_MESSAGE;
  const faqChannelId = String(config.ticketFaqChannelId || TICKET_FAQ_CHANNEL_ID);

  const embed = new EmbedBuilder()
    .setTitle('Contact the support')
    .setDescription(panelMessage)
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
      .setURL(`https://discord.com/channels/${resolvedGuildId}/${faqChannelId}`),
  );

  return {
    embeds: [forceCloudyTicketFooter(embed)],
    components: [row],
  };
}
