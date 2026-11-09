import { Events } from 'discord.js';
import { processRustRestartNotices } from '../services/rustRestartScheduleService.js';
import { logger } from '../utils/logger.js';

const active = new Set();
let timer = null;

export default {
  name: Events.ClientReady,
  once: false,
  async execute(client) {
    if (timer) return;
    const tick = async () => {
      if (active.has('tick')) return;
      active.add('tick');
      try {
        await processRustRestartNotices(client);
      } catch (error) {
        logger.warn('[RUST_RESTART] Tick failed:', error);
      } finally {
        active.delete('tick');
      }
    };
    timer = setInterval(tick, 60_000);
    timer.unref?.();
    await tick();
  },
};
