import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';

const OLD_LOGO_FILENAMES = new Set([
  'cloudy-ticket-welcome-c.png',
  'cloudy-ticket-c-layout.png',
]);

async function cleanChannel(channel, clientUserId) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return;
  if (!/ticket-\d+/i.test(String(channel.name || ''))) return;
  if (!channel.messages?.fetch) return;

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages) return;

  for (const message of messages.values()) {
    if (message.author?.id !== clientUserId) continue;
    if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) continue;

    try {
      const raw = forceCloudyTicketFooter(message.embeds[0]);
      const hasOldLogoAttachment = [...message.attachments.values()].some(
        attachment => OLD_LOGO_FILENAMES.has(attachment.name),
      );

      await message.edit({
        embeds: [raw],
        ...(hasOldLogoAttachment ? { attachments: [] } : {}),
      });
    } catch (error) {
      logger.warn('Could not restore bottom-right Cloudy C on existing ticket', {
        guildId: message.guild?.id,
        channelId: channel.id,
        messageId: message.id,
        error: error.message,
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
