import { Events } from 'discord.js';
import { GIVEAWAY_BUILDER_PREFIX, handleGiveawayBuilderInteraction } from '../services/giveawayBuilderService.js';

// Giveaway Builder controls (buttons, channel/role pickers, forms) are
// handled here; the generic router skips the gbuilder: IDs.
export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith(GIVEAWAY_BUILDER_PREFIX)) {
      await handleGiveawayBuilderInteraction(interaction, client);
    }
  },
};
