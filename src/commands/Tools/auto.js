import { SlashCommandBuilder } from 'discord.js';
import { openCloudyFeedDashboard } from '../../services/cloudyFeedDashboardService.js';
import { openAutomationDashboard } from '../../services/automationBuilderService.js';

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
      .setDescription('Open the Cloudy feed dashboard'))
    .addSubcommand(command => command
      .setName('giveaway')
      .setDescription('Open the automatic giveaway builder'))
    .addSubcommand(command => command
      .setName('vote')
      .setDescription('Open the automatic vote builder')),

  category: 'Tools',
  adminOnly: false,

  async execute(interaction, _config, client) {
    const sub = interaction.options.getSubcommand(false);
    if (sub === 'feed') return openCloudyFeedDashboard(interaction, client);
    if (sub === 'vote' || sub === 'giveaway') return openAutomationDashboard(interaction, sub);
  },
};
