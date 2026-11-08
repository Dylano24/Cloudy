import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { supportBotEmoji } from './supportBotEmojiService.js';
import {
  CLOUDY_TICKET_FOOTER,
  forceCloudyTicketFooter,
} from '../utils/ticket/ticketBranding.js';

export const DEFAULT_TICKET_PANEL_TITLE = 'Contact the support';
export const DEFAULT_TICKET_PANEL_MESSAGE = `If you need assistance or have something to report, simply hit the **Start Chat** button below and our team will get back to you as soon as possible.

Before submitting a request, please make sure the answer to your question cannot already be found in our **FAQ** section using the button at the bottom right.`;
export const DEFAULT_TICKET_BUTTON_LABEL = 'Start Chat';
export const TICKET_FAQ_CHANNEL_ID = '1554538586001645679';
export const TICKET_START_CHAT_EMOJI = { id: '1568808462782177280', name: 'white_bubble' };
export { CLOUDY_TICKET_FOOTER };

function resolveGuildId(client, guildId = null) {
  if (guildId) return guildId;
  const faqChannel = client?.channels?.cache?.get?.(TICKET_FAQ_CHANNEL_ID);
  if (faqChannel?.guildId) return faqChannel.guildId;
  return client?.guilds?.cache?.first?.()?.id || '@me';
}

export function buildTicketPanelComponents(client, guildId, config = {}, sourceRows = null) {
  const resolvedGuildId = resolveGuildId(client, guildId);
  const rows = sourceRows?.length ? sourceRows.map(row => {
    const data = row.toJSON?.() || row;
    if (data.type !== 1) throw new Error('The source ticket controls must be action rows');
    return {type: 1, components: data.components.map(button => button.toJSON?.() || button)};
  }) : [{type: 1, components: [new ButtonBuilder()
    .setCustomId('create_ticket').setLabel(config.ticketButtonLabel || DEFAULT_TICKET_BUTTON_LABEL)
    .setStyle(ButtonStyle.Secondary).setEmoji(TICKET_START_CHAT_EMOJI).toJSON()]}];
  const isFaqLink = button => Number(button.style) === ButtonStyle.Link
    && /faq|support assistant|cloudy assistant/i.test(String(button.label || ''));
  // The former FAQ link led to the AI assistant. The owner explicitly moved
  // FAQ to this channel; preserve any different, deliberately configured ID.
  const configured = String(config.ticketFaqChannelId || '');
  const faqChannelId = configured && configured !== '1534654577385672917' ? configured : TICKET_FAQ_CHANNEL_ID;
  const support = () => new ButtonBuilder().setLabel('Cloudy assistant')
    .setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${resolvedGuildId}/${faqChannelId}`)
    .setEmoji(supportBotEmoji(client));
  let found = false;
  const result = rows.map(row => new ActionRowBuilder().addComponents(row.components.map(button => {
    if (!isFaqLink(button)) {
      // Upgrade only the old default mail / generic emoji; preserve other custom icons.
      const isStartChat = button.custom_id === 'create_ticket';
      const oldEmoji = (!button.emoji?.id && (!button.emoji || button.emoji.name === '💬'))
        || button.emoji?.id === '1543303628159320165';
      return new ButtonBuilder(isStartChat && oldEmoji ? { ...button, emoji: TICKET_START_CHAT_EMOJI } : button);
    }
    found = true;
    return support();
  })));
  if (!found) {
    const last = result.at(-1);
    if (last?.components.length < 5) last.addComponents(support());
    else result.push(new ActionRowBuilder().addComponents(support()));
  }
  if (result.length > 5) throw new Error('Too many ticket control rows');
  return result;
}

export function buildTicketPanelPayload(client, guildId, config = {}) {
  const resolvedGuildId = resolveGuildId(client, guildId);
  const panelTitle = typeof config.ticketPanelTitle === 'string' && config.ticketPanelTitle.trim()
    ? config.ticketPanelTitle.trim()
    : DEFAULT_TICKET_PANEL_TITLE;
  const panelMessage = typeof config.ticketPanelMessage === 'string' && config.ticketPanelMessage.trim()
    ? config.ticketPanelMessage
    : DEFAULT_TICKET_PANEL_MESSAGE;

  const embed = new EmbedBuilder()
    .setTitle(panelTitle)
    .setDescription(panelMessage)
    .setColor('#FFFFFF');

  return {
    embeds: [forceCloudyTicketFooter(embed)],
    components: buildTicketPanelComponents(client, resolvedGuildId, config),
  };
}
