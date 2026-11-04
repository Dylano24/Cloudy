import { Events } from 'discord.js';
import { startGiveawayClaimCleanup } from '../services/giveawayClaimService.js';
import { removeExistingClaimLogTimestamps, refreshExistingGiveawayClaimLogPresentation, refreshClosedGiveawayClaimLogChannels, refreshClosedClaimReferencesInEarlierLogs, removeRedundantGiveawayClaimLogs, refreshHistoricalGiveawayClaimNumbersAndDates, refreshGiveawayAutoExpiryLogAction, refreshGiveawayClaimTitlesWithoutAction } from '../services/giveawayClaimLogService.js';
import { refreshExistingGiveawayClaimInstructions, refreshEndedGiveawayClosingCopy } from '../services/giveawayActions.js';
import { logger } from '../utils/logger.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    startGiveawayClaimCleanup(client);
    void removeExistingClaimLogTimestamps(client)
      .then(() => refreshExistingGiveawayClaimLogPresentation(client))
      .then(() => refreshClosedGiveawayClaimLogChannels(client))
      .then(() => refreshClosedClaimReferencesInEarlierLogs(client))
      .then(() => removeRedundantGiveawayClaimLogs(client))
      .then(() => refreshHistoricalGiveawayClaimNumbersAndDates(client))
      .then(() => refreshGiveawayAutoExpiryLogAction(client))
      .then(() => refreshGiveawayClaimTitlesWithoutAction(client))
      .catch(error => logger.warn('Could not refresh giveaway claim log presentation', error));
    void refreshEndedGiveawayClosingCopy(client).catch(error =>
      logger.warn('Could not refresh ended giveaway message text', error));
    void refreshExistingGiveawayClaimInstructions(client).catch(error =>
      logger.warn('Could not update existing giveaway winner announcements', error));
  },
};
