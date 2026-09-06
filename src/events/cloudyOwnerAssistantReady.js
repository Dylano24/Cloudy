import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { logger } from '../utils/logger.js';

export const FIX_GUIDE_CHANNEL_ID = '1546229542027534478';
export const FIX_GUIDE_ASK_BUTTON_ID = 'cloudy_fix_guide_ask';
export const FIX_GUIDE_ASK_MODAL_ID = 'cloudy_fix_guide_ask_modal';
export const FIX_GUIDE_QUESTION_INPUT_ID = 'cloudy_fix_guide_question';

const PANEL_STATE_KEY = `global:cloudy-owner-assistant:panel:${FIX_GUIDE_CHANNEL_ID}`;
const PANEL_TITLE = 'Cloudy Assistant • Fix Guide';

function buildPanel() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(FIX_GUIDE_ASK_BUTTON_ID)
      .setLabel('Ask')
      .setEmoji('❔')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(PANEL_TITLE)
        .setDescription(
          'Ask Cloudy anything — from technical Cloudy problems and bot errors to programming, troubleshooting, research and current information.\n\n' +
          'Cloudy can investigate the live server, current bot context, embeds, runtime diagnostics, relevant source code and current public information when needed.\n\n' +
          '**How to use:** Click **❔ Ask** below and describe exactly what you want to know or fix.'
        )
        .setFooter({ text: '© Cloudy Inc. • Quality. Innovation. Performance.' }),
    ],
    components: [row],
  };
}

function isAssistantPanel(message, clientUserId) {
  return message.author?.id === clientUserId && (
    message.components?.some(row => row.components?.some(component => component.customId === FIX_GUIDE_ASK_BUTTON_ID))
    || message.embeds?.some(embed => embed.title === PANEL_TITLE)
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const channel = await client.channels.fetch(FIX_GUIDE_CHANNEL_ID).catch(() => null);
      if (!channel?.isTextBased?.() || channel.isThread?.() || !channel.messages?.fetch) {
        logger.warn(`[OWNER_ASSISTANT] FIX-GUIDE channel unavailable: ${FIX_GUIDE_CHANNEL_ID}`);
        return;
      }

      let panelMessage = null;
      const savedMessageId = client.db?.get
        ? await client.db.get(PANEL_STATE_KEY).catch(() => null)
        : null;

      if (savedMessageId) {
        panelMessage = await channel.messages.fetch(savedMessageId).catch(() => null);
        if (panelMessage && !isAssistantPanel(panelMessage, client.user.id)) panelMessage = null;
      }

      if (!panelMessage) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        panelMessage = recent?.find(message => isAssistantPanel(message, client.user.id)) || null;
      }

      panelMessage = panelMessage
        ? await panelMessage.edit(buildPanel())
        : await channel.send(buildPanel());

      if (client.db?.set) await client.db.set(PANEL_STATE_KEY, panelMessage.id).catch(() => {});
      logger.info(`[OWNER_ASSISTANT] FIX-GUIDE panel ready in channel ${FIX_GUIDE_CHANNEL_ID}`);
    } catch (error) {
      logger.error('[OWNER_ASSISTANT] Failed to reconcile FIX-GUIDE panel:', error);
    }
  },
};
