import { Events } from 'discord.js';
import { renderTicketV2 } from '../services/ticketV2LayoutService.js';

function usesLegacyTicketLayout(message) {
  const embed = message?.embeds?.[0];
  if (!embed?.title?.startsWith('Ticket #')) return false;

  const description = String(embed.description || '');
  const legacyText =
    description.includes('Our team will be with you as soon as possible.')
    || description.includes('thanks for creating a ticket!')
    || description.includes('To help us process it as quickly as possible');

  const legacyFields = Array.isArray(embed.fields)
    && embed.fields.some(field => ['Status', 'Claimed By', 'Created'].includes(field?.name));

  const legacyThumbnail = Boolean(embed.thumbnail?.url);

  return legacyText || legacyFields || legacyThumbnail;
}

export default {
  name: Events.MessageCreate,
  once: false,

  async execute(message) {
    if (!message?.client?.user?.id) return;
    if (message.author?.id !== message.client.user.id) return;
    if (!message.inGuild?.()) return;
    if (!usesLegacyTicketLayout(message)) return;

    await renderTicketV2(message.channel, message).catch(() => {});
  },
};
