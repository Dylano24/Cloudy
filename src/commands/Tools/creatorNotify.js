import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openCreatorDashboard } from '../../services/creatorDashboardService.js';

export default {
  // Opens a private dashboard (Add creator / Manage creator), like /auto feed.
  data: new SlashCommandBuilder()
    .setName('creator-notify')
    .setDescription('Automatically post new creator content to Discord')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  // Discord limits guild commands to 100. Keep this feature as one global
  // application command; existing 100 guild commands stay untouched.
  globalRegistration: true,
  category: 'Tools',
  async execute(interaction, _config, client) {
    return openCreatorDashboard(interaction, client || interaction.client);
  },
};
