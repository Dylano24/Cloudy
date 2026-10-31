import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { openGiveawayBuilder } from '../../services/giveawayBuilderService.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage giveaways.')
        .addSubcommand(option => option
            .setName('create')
            .setDescription('Open the giveaway builder to create and set a giveaway.'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'create') {
            return openGiveawayBuilder(interaction);
        }
    },
};
