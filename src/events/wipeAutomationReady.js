import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { runWipeAutomationTick } from '../services/wipeAutomationService.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    // Does nothing until the owner configures a real server, wipe time and
    // explicitly starts the relevant automation.
    void runWipeAutomationTick(client)
      .catch(error => logger.error('[WIPE_AUTO] Initial check failed:', error));
    const timer = setInterval(() => {
      void runWipeAutomationTick(client)
        .catch(error => logger.error('[WIPE_AUTO] Scheduled check failed:', error));
    }, 60_000);
    timer.unref?.();
  },
};
