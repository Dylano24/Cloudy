import { AttachmentBuilder, Events } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const TICKET_LOGO_FILENAME = 'cloudy-ticket-c-layout.png';
const TICKET_LOGO_URL = `attachment://${TICKET_LOGO_FILENAME}`;

function isMainTicketMessage(message, clientUserId) {
  return Boolean(
    message?.guild?.id
    && message.author?.id === clientUserId
    && message.embeds?.[0]?.title?.startsWith('Ticket #'),
  );
}

function buildLogoFile() {
  return new AttachmentBuilder(
    fileURLToPath(new URL('../../assets/cloudy-ticket-c-layout.png', import.meta.url)),
    { name: TICKET_LOGO_FILENAME },
  );
}

async function ensureTicketLogo(message) {
  const embed = message.embeds?.[0];
  if (!embed) return;

  const raw = embed.toJSON();
  raw.image = { url: TICKET_LOGO_URL };

  const hasLogo = [...message.attachments.values()].some(
    attachment => attachment.name === TICKET_LOGO_FILENAME,
  );

  const payload = { embeds: [raw] };
  if (!hasLogo) payload.files = [buildLogoFile()];

  await message.edit(payload);
}

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message, client) {
    if (!isMainTicketMessage(message, client.user?.id)) return;

    const apply = async () => {
      const fresh = await message.channel.messages.fetch(message.id).catch(() => message);
      await ensureTicketLogo(fresh).catch(error => {
        logger.warn('Could not attach Cloudy C to new ticket message', {
          guildId: message.guild?.id,
          channelId: message.channelId,
          messageId: message.id,
          error: error.message,
        });
      });
    };

    await apply();

    const timer = setTimeout(apply, 1500);
    timer.unref?.();
  },
};
