import { ChannelType, Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const BOT_COMMANDS_CHANNEL_ID = '1539371836570083368';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    logger.warn('[EMBED_BUILDER] Preparing private response catalog channel.');
    for (const guild of client.guilds.cache.values()) {
      let thread = [...guild.channels.cache.values()].find(channel =>
        channel?.isThread?.() && ['botlog', 'cloudy-response-catalog-loading'].includes(String(channel.name || '').toLowerCase()),
      );

      if (!thread) {
        const parent = guild.channels.cache.get(BOT_COMMANDS_CHANNEL_ID);
        if (!parent?.threads?.create) {
          logger.warn('[EMBED_BUILDER] Bot commands channel cannot create response catalog thread.');
          continue;
        }
        thread = await parent.threads.create({
          name: 'botlog',
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: 10080,
          reason: 'Cloudy internal response template catalog',
        }).catch(error => {
          logger.warn(`[EMBED_BUILDER] Private catalog thread creation failed: ${error.message}`);
          return null;
        });
      }

      if (thread?.archived) await thread.setArchived(false).catch(() => {});
      if (thread && String(thread.name || '').toLowerCase() !== 'botlog') {
        await thread.setName('botlog').catch(() => {});
      }
      if (thread) logger.warn(`[EMBED_BUILDER] Private catalog channel ready: ${thread.id}.`);
    }
  },
};
