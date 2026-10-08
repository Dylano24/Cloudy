import { Events } from 'discord.js';
import { handleFeedInteraction } from '../services/cloudyFeedService.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith('cloudyfeed:')) {
      await handleFeedInteraction(interaction, client);
    }
  },
};
