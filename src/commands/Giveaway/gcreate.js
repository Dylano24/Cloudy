import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { openGiveawayBuilder } from '../../services/giveawayBuilderService.js';

// Opens the Giveaway Builder (private preview with controls, like the Embed
// Builder). Prize, text, tag, channel, duration and winners are set there.
export default {
    data: new SlashCommandBuilder()
        .setName('gcreate')
        .setDescription('Opens the Giveaway Builder to create and post a giveaway.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await openGiveawayBuilder(interaction);
    },
};
