import { Events } from 'discord.js';
import { removeClaimSuccessNoticesForChannel } from '../services/giveawayClaimService.js';
import { logger } from '../utils/logger.js';

// Handles a giveaway claim channel being deleted by staff or another system.
// The in-memory notice lookup ensures unrelated channel deletions do nothing.
export default {
  name: Events.ChannelDelete,
  once: false,
  async execute(channel, client) {
    const activeClient = client || channel?.client;
    if (!activeClient || !channel?.id) return;
    await removeClaimSuccessNoticesForChannel(activeClient, channel.id)
      .catch(error => logger.warn('Could not remove giveaway Claim success notice after channel deletion:', error));
  },
};
