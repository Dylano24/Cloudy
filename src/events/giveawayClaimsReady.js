import { Events } from 'discord.js';
import { startGiveawayClaimCleanup } from '../services/giveawayClaimService.js';
import { refreshExistingGiveawayClaimInstructions } from '../services/giveawayActions.js';
import { logger } from '../utils/logger.js';
import { removeLegacyGiveawayManageButtons } from '../services/giveawayManageMigration.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startGiveawayClaimCleanup(client);
    void removeLegacyGiveawayManageButtons(client).catch(error =>
      logger.warn('One-time giveaway Manage button migration failed', error));
    void refreshExistingGiveawayClaimInstructions(client).catch(error =>
      logger.warn('Could not update existing giveaway winner announcements', error));
  },
};
