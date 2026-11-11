import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
  removeExistingClaimLogTimestamps,
  refreshExistingGiveawayClaimLogPresentation,
  refreshClosedGiveawayClaimLogChannels,
  refreshHistoricalGiveawayClaimNumbersAndDates,
  refreshGiveawayAutoExpiryLogAction,
  refreshGiveawayClaimTitlesWithoutAction,
  removeRedundantGiveawayClaimLogs,
} from '../src/services/giveawayClaimLogService.js';

test('claim-log migrations never request a channel from a different guild', async () => {
  const owner = '1565734585508303029';
  const foreign = '1532882647838228723';
  let foreignFetches = 0;
  let ownerFetches = 0;
  const channel = {
    messages: { fetch: async () => { ownerFetches++; return new Collection(); } },
  };
  const guilds = new Collection([
    [foreign, {
      id: foreign,
      channels: { cache: new Collection(), fetch: async () => { foreignFetches++; throw Error('foreign channel'); } },
    }],
    [owner, {
      id: owner,
      channels: { cache: new Collection([[GIVEAWAY_CLAIM_LOG_CHANNEL_ID, channel]]) },
    }],
  ]);
  const client = {
    user: { id: 'bot' },
    guilds: { cache: guilds },
    db: { get: async (_key, fallback) => fallback, set: async () => true },
  };
  await removeExistingClaimLogTimestamps(client);
  await refreshExistingGiveawayClaimLogPresentation(client);
  await refreshClosedGiveawayClaimLogChannels(client);
  await refreshHistoricalGiveawayClaimNumbersAndDates(client);
  await refreshGiveawayAutoExpiryLogAction(client);
  await refreshGiveawayClaimTitlesWithoutAction(client);
  await removeRedundantGiveawayClaimLogs(client);
  assert.equal(foreignFetches, 0, 'never fetch Dylano claim log through Cloudy Inc guild');
  assert.ok(ownerFetches > 0, 'the real owner guild remains eligible for migration');
});
