import { Events } from 'discord.js';
import { handleCreatorControls } from '../services/creatorDashboardService.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    if (interaction.customId?.startsWith('creatornotify:')) {
      await handleCreatorControls(interaction, client || interaction.client);
    }
  },
};
