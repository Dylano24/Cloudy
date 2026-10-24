import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';

export const FIX_GUIDE_CHANNEL_ID = '1546229542027534478';
export const FIX_GUIDE_ASK_BUTTON_ID = 'cloudy_fix_guide_ask';
export const FIX_GUIDE_ASK_MODAL_ID = 'cloudy_fix_guide_ask_modal';
export const FIX_GUIDE_QUESTION_INPUT_ID = 'cloudy_fix_guide_question';

const panelStateKey = channelId => `global:cloudy-owner-assistant:panel:${channelId}`;
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
          'Ask Cloudy anything, from technical Cloudy problems and bot errors to programming, troubleshooting, research and current information.\n\n' +
          'In this Owner Fix Guide, Cloudy can automatically use relevant history from server channels that both you and the bot are allowed to read. Explicit scan, history, analyze and prepare commands remain available. Type help for instructions. Proposals are not executed. No live web access.\n\n' +
          '**How to use:** Click **❔ Ask** below and describe exactly what you want to know or fix.'
        )
        .setFooter({ text: '© Cloudy Inc. • Quality. Innovation. Performance.' }),
    ],
    components: [row],
  };
}

function fixGuideComponents(message) {
  return (message?.components || []).flatMap(row => row?.components || []);
}

export function isFixGuidePanelComponentContractSafe(message, clientUserId) {
  if (message?.author?.id !== clientUserId) return false;
  const components = fixGuideComponents(message);
  return components.length === 1
    && components[0]?.customId === FIX_GUIDE_ASK_BUTTON_ID;
}

function isAssistantPanel(message, clientUserId) {
  return message.author?.id === clientUserId && (
    message.components?.some(row => row.components?.some(component => component.customId === FIX_GUIDE_ASK_BUTTON_ID))
    || message.embeds?.some(embed => embed.title === PANEL_TITLE)
  );
}

async function repairFixGuideComponents(message, payload, clientUserId) {
  if (!message || isFixGuidePanelComponentContractSafe(message, clientUserId)) return message;
  try {
    return await message.edit({ components: payload.components }) || message;
  } catch (error) {
    logger.error('[OWNER_ASSISTANT] Failed to repair FIX-GUIDE components:', {
      guildId: message?.guildId,
      channelId: message?.channelId,
      messageId: message?.id,
      error: error?.message || String(error),
    });
    return null;
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const channel = await resolveCloudyChannel(client, 'fixGuide', { textOnly: true });
      if (!channel?.isTextBased?.() || channel.isThread?.() || !channel.messages?.fetch) {
        logger.warn(`[OWNER_ASSISTANT] FIX-GUIDE channel unavailable: ${FIX_GUIDE_CHANNEL_ID}`);
        return;
      }

      let panelMessage = null;
      const savedMessageId = client.db?.get
        ? await client.db.get(panelStateKey(channel.id)).catch(() => null)
        : null;

      if (savedMessageId) {
        panelMessage = await channel.messages.fetch(savedMessageId).catch(() => null);
        if (panelMessage && !isAssistantPanel(panelMessage, client.user.id)) panelMessage = null;
      }

      if (!panelMessage) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        panelMessage = recent?.find(message => isAssistantPanel(message, client.user.id)) || null;
      }

      const panelPayload = buildPanel();
      panelMessage = panelMessage
        ? await repairFixGuideComponents(panelMessage, panelPayload, client.user.id)
        : await channel.send(panelPayload);

      if (!panelMessage) {
        panelMessage = await channel.send(panelPayload);
      }

      // Existing panels do not emit MessageCreate after a restart. Re-register
      // the live message explicitly so Search and channel Modify always share
      // the same complete snapshot and component rows.
      await registerCloudyEmbedMessage(panelMessage, 'bot-history');

      if (client.db?.set) await client.db.set(panelStateKey(channel.id), panelMessage.id).catch(() => {});
      logger.warn(`[OWNER_ASSISTANT] FIX-GUIDE panel ready in channel ${channel.id}`);
    } catch (error) {
      logger.error('[OWNER_ASSISTANT] Failed to reconcile FIX-GUIDE panel:', error);
    }
  },
};
