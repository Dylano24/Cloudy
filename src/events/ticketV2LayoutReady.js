import { PRESERVE_EXISTING_EMBEDS } from '../services/existingEmbedPolicy.js';
import { ChannelType, Events } from 'discord.js';
import { renderTicketV2 } from '../services/ticketV2LayoutService.js';

function isTicketChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  return /ticket-\d+/i.test(String(channel.name || ''));
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    if (PRESERVE_EXISTING_EMBEDS) return;
    const timer = setTimeout(async () => {
      for (const guild of client.guilds.cache.values()) {
        const channels = guild.channels.cache.filter(isTicketChannel);
        for (const channel of channels.values()) {
          await renderTicketV2(channel).catch(() => {});
        }
      }
    }, 2500);
    timer.unref?.();
  },
};
