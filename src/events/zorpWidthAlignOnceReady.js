import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { normalizeManualIndent } from '../utils/manualEmbedIndent.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';

const TARGET_MESSAGE_ID = '1554543233047199787';
const TARGET_FIELDS = new Set([
  'how to claim a zorp zone',
  'important information',
  'how to remove a zorp zone',
]);

function cleanFieldName(value = '') {
  return String(value).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const channel = await resolveCloudyChannel(client, 'zorp', { textOnly: true });
      if (!channel?.messages?.fetch) {
        logger.warn('[ZORP_WIDTH_ONCE] ZORP channel unavailable.');
        return;
      }

      let message = await channel.messages.fetch(TARGET_MESSAGE_ID).catch(() => null);
      if (!message) {
        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        message = recent?.find(item => item.author?.id === client.user.id
          && item.embeds?.some(embed => embed.title?.endsWith(' ZORP Guide') || embed.title === 'ZORP Guide')) || null;
      }
      if (!message?.editable) {
        logger.warn('[ZORP_WIDTH_ONCE] Live ZORP Guide was not found/editable.');
        return;
      }

      const embedIndex = message.embeds.findIndex(embed => embed.title?.endsWith(' ZORP Guide') || embed.title === 'ZORP Guide');
      if (embedIndex < 0) {
        logger.warn('[ZORP_WIDTH_ONCE] Live message has no ZORP Guide embed.');
        return;
      }

      const embeds = message.embeds.map(embed => embed.toJSON());
      const original = embeds[embedIndex];
      const updated = {
        ...original,
        fields: (original.fields || []).map(field => TARGET_FIELDS.has(cleanFieldName(field.name))
          ? { ...field, value: normalizeManualIndent(field.value, { zorp: true }) }
          : field),
      };

      if (JSON.stringify(updated) === JSON.stringify(original)) {
        logger.warn('[ZORP_WIDTH_ONCE] VERIFIED already_current message=' + message.id);
        return;
      }

      embeds[embedIndex] = updated;
      const edited = await message.edit({ embeds });
      await registerCloudyEmbedMessage(edited, 'embed-builder');
      logger.warn('[ZORP_WIDTH_ONCE] VERIFIED updated message=' + edited.id + ' width=283px indent=14px');
    } catch (error) {
      logger.error('[ZORP_WIDTH_ONCE] Failed:', error);
    }
  },
};
