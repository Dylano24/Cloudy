import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';

const OLD_LOGO_FILENAMES = new Set([
  'cloudy-ticket-welcome-c.png',
  'cloudy-ticket-c-layout.png',
]);

function isOldLogoAttachment(attachment) {
  return OLD_LOGO_FILENAMES.has(attachment?.name);
}

async function cleanMainTicketMessage(message) {
  const currentEmbed = message.embeds[0].toJSON();
  const brandedEmbed = forceCloudyTicketFooter(message.embeds[0]);
  const attachments = [...message.attachments.values()];
  const onlyOldLogoAttachments = attachments.length > 0 && attachments.every(isOldLogoAttachment);
  const needsContentCleanup = Boolean(message.content);
  const needsEmbedCleanup = JSON.stringify(currentEmbed) !== JSON.stringify(brandedEmbed);

  if (!needsContentCleanup && !needsEmbedCleanup && !onlyOldLogoAttachments) return false;

  await message.edit({
    ...(needsContentCleanup ? { content: null } : {}),
    ...(needsEmbedCleanup ? { embeds: [brandedEmbed] } : {}),
    ...(onlyOldLogoAttachments ? { attachments: [] } : {}),
  });

  return true;
}

async function cleanChannel(channel, clientUserId) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return;
  if (!/ticket-\d+/i.test(String(channel.name || ''))) return;
  if (!channel.messages?.fetch) return;

  let before;

  // Walk backwards until the main ticket message is found. This avoids the old
  // 25-message limit while stopping as soon as the single header message has
  // been inspected.
  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    }).catch(() => null);

    if (!messages?.size) return;

    for (const message of messages.values()) {
      if (message.author?.id !== clientUserId) continue;
      if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) continue;

      await cleanMainTicketMessage(message).catch(error => {
        logger.warn('Could not clean existing Cloudy ticket message', {
          guildId: message.guild?.id,
          channelId: channel.id,
          messageId: message.id,
          error: error.message,
        });
      });
      return;
    }

    if (messages.size < 100) return;
    before = messages.last()?.id;
    if (!before) return;
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
