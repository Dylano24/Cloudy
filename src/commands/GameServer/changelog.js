import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { changeLogModal } from '../../services/changeLogService.js';

// Staff only: opens the change log form; the post goes to #change-logs.
export default {
  slashOnly: true,
  data: new SlashCommandBuilder()
    .setName('changelog')
    .setDescription('Post the settings you changed on a game server in #change-logs.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    return interaction.showModal(changeLogModal());
  },
};
