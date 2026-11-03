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
    void refreshExistingGiveawayClaimLogPresentation(client).catch(error =>
      logger.warn('Could not refresh old giveaway claim log mentions and closed colors', error));
    void removeExistingClaimLogTimestamps(client).catch(error =>
      logger.warn('Could not refresh giveaway claim log footers', error));
    void refreshExistingGiveawayClaimInstructions(client).catch(error =>
      logger.warn('Could not update existing giveaway winner announcements', error));
  },
};
