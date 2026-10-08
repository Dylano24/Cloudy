import { SlashCommandBuilder } from 'discord.js';
import { openCloudyFeedDashboard } from '../../services/cloudyFeedDashboardService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('auto')
    .setDescription('Owner-only automatic features')
    // Default disabled: server Integration settings can enable this for the Owner role.
    // Role membership is independently verified in every handler.
    .setDefaultMemberPermissions(0n)
    .setDMPermission(false)
    .addSubcommand(command => command
      .setName('feed')
      .setDescription('Open the Cloudy feed dashboard')),

  category: 'Tools',
  adminOnly: false,

  async execute(interaction, _config, client) {
    if (interaction.options.getSubcommand(false) !== 'feed') return;
    await openCloudyFeedDashboard(interaction, client);
  },
};
