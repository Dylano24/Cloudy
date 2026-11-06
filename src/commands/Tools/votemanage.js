import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openVoteManager } from '../../services/voteManageService.js';

// /votemanage (owner's choice, like /giveaway manage): see active and ended
// votes, end or delete them. Staff only.
export default {
  data: new SlashCommandBuilder()
    .setName('votemanage')
    .setDescription('Manage votes: see active and ended votes, end or delete them.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  execute: openVoteManager,
};
