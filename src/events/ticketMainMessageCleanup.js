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

async function cleanMainTicketMessage(message) {
  const raw = forceCloudyTicketFooter(message.embeds[0]);
  const hasOldLogoAttachment = [...message.attachments.values()].some(
    attachment => OLD_LOGO_FILENAMES.has(attachment.name),
  );

  await message.edit({
    content: null,
    embeds: [raw],
    ...(hasOldLogoAttachment ? { attachments: [] } : {}),
  });
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
