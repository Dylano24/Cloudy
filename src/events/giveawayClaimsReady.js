import { Events } from 'discord.js';
import { startGiveawayClaimCleanup } from '../services/giveawayClaimService.js';
import { removeExistingClaimLogTimestamps, refreshExistingGiveawayClaimLogPresentation } from '../services/giveawayClaimLogService.js';
import { refreshExistingGiveawayClaimInstructions } from '../services/giveawayActions.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startGiveawayClaimCleanup(client);
    void removeExistingClaimLogTimestamps(client)
      .then(() => refreshExistingGiveawayClaimLogPresentation(client))
      .catch(error => logger.warn('Could not refresh giveaway claim log presentation', error));
    void refreshExistingGiveawayClaimInstructions(client).catch(error =>
      logger.warn('Could not update existing giveaway winner announcements', error));
  },
};
