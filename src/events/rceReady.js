import { Events } from 'discord.js';
import { createRceRuntime, getRceRuntime } from '../services/rce/rceRuntime.js';
import { rceGuildIds } from '../services/rce/rceStore.js';
import { logger } from '../utils/logger.js';

// Rust Console Edition: connects every configured game server once Cloudy is
// ready. A delivery that was being sent during a restart is never resent.
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      const runtime = getRceRuntime() || createRceRuntime(client);
      for (const guildId of await rceGuildIds(client).catch(() => [])) {
        await runtime.deliveries.recoverInterrupted(guildId).catch(() => undefined);
      }
      await runtime.start();
    } catch (error) {
      logger.error('[RCE] The Rust Console module could not start:', error);
    }
  },
};
