import { Events } from 'discord.js';
import { resolveCloudyChannel } from '../services/cloudyChannelResolver.js';

const checks = [
  { key: 'terms', title: /Terms of service$/i },
  { key: 'termsOfSale', title: /Store terms of sale$/i },
  { key: 'faq', customId: 'faq_ai_question' },
  { key: 'zorp', title: /ZORP Guide$/i },
  { key: 'security', title: /^Security information$/i },
  { key: 'staffList', title: /^Staff team$/i },
  { key: 'appeal', title: /^Appeal form$/i },
  { key: 'staffReviews', customId: 'staff_review_member' },
  { key: 'fixGuide', customId: 'cloudy_fix_guide_ask' },
  { key: 'shop', title: /^Shop commands$/i },
  { key: 'gambling', title: /^Gambling & Games$/i },
  { key: 'contactSupport', customId: 'create_ticket' },
];

function hasCustomId(message, customId) {
  return message.components?.some(row =>
    row.components?.some(component => component.customId === customId)
  );
}

function matchesCheck(message, check, botId) {
  if (message.author?.id !== botId) return false;
  if (check.customId && hasCustomId(message, check.customId)) return true;
  if (check.title && message.embeds?.some(embed => check.title.test(String(embed.title || '')))) return true;
  return false;
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      for (const check of checks) {
        const channel = await resolveCloudyChannel(client, check.key, { textOnly: true });
        if (!channel?.messages?.fetch) {
          console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({ key: check.key, ok: false, reason: 'channel_missing' }));
          continue;
        }

        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!recent) {
          console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({ key: check.key, channelId: channel.id, name: channel.name, ok: false, reason: 'history_unavailable' }));
          continue;
        }

        const match = recent.find(message => matchesCheck(message, check, client.user.id)) || null;
        console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({
          key: check.key,
          channelId: channel.id,
          name: channel.name,
          ok: Boolean(match),
          messageId: match?.id || null,
          recentCount: recent.size,
        }));
      }
    }, 20000);
    timer.unref?.();
  },
};
