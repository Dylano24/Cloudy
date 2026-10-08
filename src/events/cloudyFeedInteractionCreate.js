import { Events } from 'discord.js';
import { handleCloudyFeedControls } from '../services/cloudyFeedDashboardService.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith('cloudyfeed:')) {
      await handleCloudyFeedControls(interaction, client);
    }
  },
};
