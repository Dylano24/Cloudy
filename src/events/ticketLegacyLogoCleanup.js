import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const LEGACY_LOGO_FILENAME = 'cloudy-ticket-welcome-c.png';

async function cleanChannel(channel, clientUserId) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return;
  if (!/ticket-\d+/i.test(String(channel.name || ''))) return;
  if (!channel.messages?.fetch) return;

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages) return;

  for (const message of messages.values()) {
    if (message.author?.id !== clientUserId) continue;
    if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) continue;

    const legacyAttachments = [...message.attachments.values()].filter(
      attachment => attachment.name === LEGACY_LOGO_FILENAME,
    );

    // The old duplicate-logo system attached this as the only file on the
    // main ticket message. Remove it so only the embed's bottom-right C remains.
    if (legacyAttachments.length === 1 && message.attachments.size === 1) {
      await message.edit({ attachments: [] }).catch(error => {
        logger.warn('Could not remove legacy duplicate ticket C attachment', {
          guildId: message.guild?.id,
          channelId: channel.id,
          messageId: message.id,
          error: error.message,
        });
      });
    }
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    for (const guild of client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        await cleanChannel(channel, client.user?.id);
      }
    }
  },
};
