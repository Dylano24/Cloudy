import { AttachmentBuilder, Events } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const LEGACY_LOGO_FILENAME = 'cloudy-ticket-welcome-c.png';
const TICKET_LOGO_FILENAME = 'cloudy-ticket-c-layout.png';
const TICKET_LOGO_URL = `attachment://${TICKET_LOGO_FILENAME}`;

function buildLogoFile() {
  return new AttachmentBuilder(
    fileURLToPath(new URL('../../assets/cloudy-ticket-c-layout.png', import.meta.url)),
    { name: TICKET_LOGO_FILENAME },
  );
}

async function ensureTicketLogo(message) {
  let current = message;

  const legacyAttachments = [...current.attachments.values()].filter(
    attachment => attachment.name === LEGACY_LOGO_FILENAME,
  );

  if (legacyAttachments.length === 1 && current.attachments.size === 1) {
    current = await current.edit({ attachments: [] });
  }

  const embed = current.embeds?.[0];
  if (!embed) return;

  const raw = embed.toJSON();
  raw.image = { url: TICKET_LOGO_URL };

  const hasLogo = [...current.attachments.values()].some(
    attachment => attachment.name === TICKET_LOGO_FILENAME,
  );

  const payload = { embeds: [raw] };
  if (!hasLogo) payload.files = [buildLogoFile()];

  await current.edit(payload);
}

async function cleanChannel(channel, clientUserId) {
  if (!channel?.isTextBased?.() || channel.isThread?.()) return;
  if (!/ticket-\d+/i.test(String(channel.name || ''))) return;
  if (!channel.messages?.fetch) return;

  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!messages) return;

  for (const message of messages.values()) {
    if (message.author?.id !== clientUserId) continue;
    if (!message.embeds?.[0]?.title?.startsWith('Ticket #')) continue;

    await ensureTicketLogo(message).catch(error => {
      logger.warn('Could not restore Cloudy C on existing ticket', {
        guildId: message.guild?.id,
        channelId: channel.id,
        messageId: message.id,
        error: error.message,
      });
    });
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
