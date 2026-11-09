import { Events } from 'discord.js';
import { refreshRustLiveBoardMirrors } from '../services/rustLiveLeaderboardService.js';
import { logger } from '../utils/logger.js';

let interval = null;

export default {
  name: Events.ClientReady,
  once: false,
  async execute(client) {
    if (interval) return;
    const sourceGuildId = String(process.env.GUILD_ID || '').trim();
    if (!sourceGuildId) return;
    const tick = () => {
      void refreshRustLiveBoardMirrors(client, sourceGuildId)
        .catch(error => logger.warn('[RUST_LIVEBOARD] Refresh failed:', error));
    };
    interval = setInterval(tick, 60_000);
    interval.unref?.();
    tick();
  },
};
