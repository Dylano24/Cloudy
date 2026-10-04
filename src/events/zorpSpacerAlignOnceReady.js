import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';
import { registerCloudyEmbedMessage } from '../services/embedRegistryService.js';

const TARGET_MESSAGE_ID = '1554543233047199787';
const SPACER_EMOJI_NAME = 'cloudy_zorp_indent';
const SPACER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAa0lEQVR42u3QwREAIAzDsJT9dw4vhuAqb2BN20nSLO1snn8AAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAn3cBkPAFfBxwf0sAAAAASUVORK5CYII=';

function cleanFieldName(value = '') {
  return String(value).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findGlowingDot(fields = []) {
  for (const field of fields) {
    if (cleanFieldName(field?.name) === 'zone colors') continue;
    const match = String(field?.value || '').match(/<a?:([^:>]*(?:glowing)?dot[^:>]*):\d+>/i);
    if (match) return match[0];
  }
  return '<:W87205667glowingdotwhite:1543291335036108830>';
}

async function ensureSpacerEmoji(client) {
  const application = client.application ?? await client.fetchApplication();
  const emojis = await application.emojis.fetch();
  let emoji = emojis.find(item => item.name === SPACER_EMOJI_NAME);
  if (!emoji) {
    emoji = await application.emojis.create({
      name: SPACER_EMOJI_NAME,
      attachment: Buffer.from(SPACER_PNG_BASE64, 'base64'),
    });
    logger.warn('[ZORP_SPACER_ONCE] Created transparent spacer emoji id=' + emoji.id);
  }
  return emoji.toString();
}

function updateField(field, dot, spacer) {
  const name = cleanFieldName(field?.name);
  if (name === 'important information') {
    return {
      ...field,
      value: [
        dot + ' ZORP zones expire after 24 hours.',
        dot + ' The timer is automatically reset while the',
        spacer + ' team is online.',
        dot + ' A team cannot create a ZORP zone that',
        spacer + ' overlaps with another team’s zone.',
        dot + ' If a player switches teams, their existing',
        spacer + ' ZORP zone will be removed to prevent',
        spacer + ' abuse.',
      ].join('\n'),
    };
  }
  if (name === 'how to remove a zorp zone') {
    return {
      ...field,
      value: [
        'To delete an existing ZORP zone:',
        '',
        dot + ' Use `Can I build around here?`',
        dot + ' Select `Good Bye` to confirm the removal.',
      ].join('\n'),
    };
  }
  return field;
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      const channel = await resolveCloudyChannel(client, 'zorp', { textOnly: true });
      if (!channel?.messages?.fetch) {
        logger.warn('[ZORP_SPACER_ONCE] ZORP channel unavailable.');
        return;
      }

      const message = await channel.messages.fetch(TARGET_MESSAGE_ID).catch(() => null);
      if (!message?.editable) {
        logger.warn('[ZORP_SPACER_ONCE] Target ZORP message not editable/found.');
        return;
      }

      const embedIndex = message.embeds.findIndex(embed => embed.title?.endsWith(' ZORP Guide') || embed.title === 'ZORP Guide');
      if (embedIndex < 0) {
        logger.warn('[ZORP_SPACER_ONCE] Target message has no ZORP Guide embed.');
        return;
      }

      const embeds = message.embeds.map(embed => embed.toJSON());
      const original = embeds[embedIndex];
      const dot = findGlowingDot(original.fields);
      const spacer = await ensureSpacerEmoji(client);
      const updated = { ...original, fields: (original.fields || []).map(field => updateField(field, dot, spacer)) };

      embeds[embedIndex] = updated;
      const edited = await message.edit({ embeds });
      await registerCloudyEmbedMessage(edited, 'embed-builder');
      logger.warn('[ZORP_SPACER_ONCE] VERIFIED updated live message=' + edited.id + ' dot=' + dot + ' spacer=' + spacer);
    } catch (error) {
      logger.error('[ZORP_SPACER_ONCE] Failed:', error);
    }
  },
};
