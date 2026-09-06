import { EmbedBuilder, Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const ASSISTANT_CHANNEL_ID = '1546229542027534478';
const PANEL_STATE_KEY = `global:cloudy-owner-assistant:panel:${ASSISTANT_CHANNEL_ID}`;
const PANEL_TITLE = 'Cloudy Assistant • Fix Guide';

function buildPanel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle(PANEL_TITLE)
        .setDescription(
          'Owners can send any technical problem or request directly in this channel.\n\n' +
          'Cloudy Assistant can investigate issues across the server and bot, check relevant context, diagnostics and settings, and help you fix problems with clear steps and targeted guidance.\n\n' +
          '**How to use:** Just type what is wrong or what you want fixed below. No command is required.'
        )
        .setFooter({ text: '© Cloudy Inc. • Quality. Innovation. Performance.' }),
    ],
  };
}

function isAssistantPanel(message, clientUserId) {
  return message.author?.id === clientUserId && message.embeds?.some(embed => embed.title === PANEL_TITLE);
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const channel = await client.channels.fetch(ASSISTANT_CHANNEL_ID).catch(() => null);
      if (!channel?.isTextBased?.() || channel.isThread?.() || !channel.messages?.fetch) {
        logger.warn(`[OWNER_ASSISTANT] FIX-GUIDE channel unavailable: ${ASSISTANT_CHANNEL_ID}`);
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

      if (client.db?.set) {
        await client.db.set(PANEL_STATE_KEY, panelMessage.id).catch(() => {});
      }

      logger.info(`[OWNER_ASSISTANT] FIX-GUIDE panel ready in channel ${ASSISTANT_CHANNEL_ID}`);
    } catch (error) {
      logger.error('[OWNER_ASSISTANT] Failed to reconcile FIX-GUIDE panel:', error);
    }
  },
};
