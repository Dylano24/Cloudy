import { Events } from 'discord.js';
import { GIVEAWAY_CLAIM_PREFIX, handleGiveawayClaimInteraction } from '../services/giveawayClaimService.js';

// Claim buttons and the private code modal run outside the general router.
export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith(GIVEAWAY_CLAIM_PREFIX)) {
      await handleGiveawayClaimInteraction(interaction, client);
    }
  },
};
