import { Events } from 'discord.js';
import { sweepExpiredTimestamps } from '../utils/runtimeStoreCleanup.js';

const COOLDOWN_SWEEP_INTERVAL_MS = 60_000;

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const timer = setInterval(() => {
      sweepExpiredTimestamps(client.cooldowns, Date.now());
    }, COOLDOWN_SWEEP_INTERVAL_MS);
    timer.unref?.();
  },
};
