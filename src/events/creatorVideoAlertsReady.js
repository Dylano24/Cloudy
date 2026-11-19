import { Events } from 'discord.js';
import {
  CREATOR_VIDEO_POLL_INTERVAL_MS, pollCreatorVideoAlerts,
} from '../services/creatorVideoAlertsService.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const check = () => {
      void pollCreatorVideoAlerts(client)
        .catch(error => logger.warn('[VIDEO_ALERTS] Scheduled check failed:', error.message));
    };
    // The feature is entirely opt-in: without connected accounts there are
    // no requests, messages, links, or changes to existing creator panels.
    const first = setTimeout(check, 5000);
    first.unref?.();
    const timer = setInterval(check, CREATOR_VIDEO_POLL_INTERVAL_MS);
    timer.unref?.();
  },
};
