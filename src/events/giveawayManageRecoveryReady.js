import { Events } from 'discord.js';
import { getGuildGiveaways } from '../utils/giveaways.js';
import { createGiveawayButtons } from '../services/giveawayService.js';
import { logger } from '../utils/logger.js';

// Temporary recovery for the owner's explicit request to restore existing
// giveaway Manage buttons. Remove after the confirmed production run.
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    let restored = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
      const giveaways = await getGuildGiveaways(client, guild.id, { strict: true });
      logger.info(`[GIVEAWAY_MANAGE_RECOVERY] scanning guild=${guild.id} giveaways=${giveaways.length}`);
      giveaways.sort((a, b) => String(b.messageId || '').localeCompare(String(a.messageId || '')));
      for (const giveaway of giveaways) {
        try {
          if (!giveaway.channelId || !giveaway.messageId) continue;
          const channel = guild.channels.cache.get(giveaway.channelId);
          if (!channel?.messages?.fetch) continue;
          logger.info(`[GIVEAWAY_MANAGE_RECOVERY] checking ${giveaway.channelId}/${giveaway.messageId}`);
          const message = await channel.messages.fetch(giveaway.messageId);
          if (message.author?.id !== client.user.id || !message.editable) continue;
          if (message.components.some(row => row.components.some(button => button.customId === 'giveaway_manage'))) continue;
          const rows = message.components.map(row => row.toJSON());
          if (rows.length >= 5) throw new Error('No free component row for Manage');
          const manage = createGiveawayButtons(giveaway).at(-1);
          await message.edit({ components: [...rows, manage] });
          restored++;
          logger.info(`[GIVEAWAY_MANAGE_RECOVERY] restored ${guild.id}/${giveaway.channelId}/${giveaway.messageId}`);
        } catch (error) {
          if (Number(error.code) === 10008) continue;
          failed++;
          logger.warn(`[GIVEAWAY_MANAGE_RECOVERY] failed ${giveaway.messageId}: ${error.message}`);
        }
      }
    }
    logger.warn(`[GIVEAWAY_MANAGE_RECOVERY] complete restored=${restored} failed=${failed}`);
  },
};
