import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { forceCloudyTicketFooter } from '../utils/ticket/ticketBranding.js';

const OLD_LOGO_FILENAMES = new Set([
  'cloudy-ticket-welcome-c.png',
  'cloudy-ticket-c-layout.png',
]);

function isMainTicketMessage(message, clientUserId) {
  return Boolean(
    message?.author?.id === clientUserId
    && message.embeds?.[0]?.title?.startsWith('Ticket #')
    && /ticket-\d+/i.test(String(message.channel?.name || ''))
  );
}

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

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    if (!isMainTicketMessage(message, client.user?.id)) return;

    await cleanMainTicketMessage(message).catch(error => {
      logger.warn('Could not clean new Cloudy ticket message', {
        guildId: message.guild?.id,
        channelId: message.channelId,
        messageId: message.id,
        error: error.message,
      });
    });
  },
};
