import { Events } from 'discord.js';
import { buildTicketPanelPayload } from '../services/ticketPanelBuilder.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { logger } from '../utils/logger.js';

const TICKET_PANEL_CHANNEL_ID = '1533197784725852181';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      const channel = client.channels.cache.get(TICKET_PANEL_CHANNEL_ID)
        || await client.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null);

      if (!channel?.isTextBased?.() || !channel?.isSendable?.()) {
        logger.warn('Ticket panel channel is unavailable or not sendable', {
          channelId: TICKET_PANEL_CHANNEL_ID,
        });
        return;
      }

      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      const existingPanel = recent?.find(message =>
        message.author?.id === client.user?.id
        && message.embeds?.some(embed => embed.title === 'Contact the support')
        && message.components?.some(row =>
          row.components?.some(component => component.customId === 'create_ticket')
        )
      );

      if (existingPanel) return;

      const config = await getGuildConfig(client, channel.guild.id).catch(() => ({}));
      await channel.send(buildTicketPanelPayload(client, channel.guild.id, config || {}));

      logger.info('Restored missing ticket panel', {
        guildId: channel.guild.id,
        channelId: channel.id,
      });
    } catch (error) {
      logger.error('Failed to restore ticket panel', error);
    }
  },
};
