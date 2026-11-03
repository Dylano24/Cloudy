import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { openGiveawayBuilder } from '../../services/giveawayBuilderService.js';
import { showGiveawayManagePicker } from '../../services/giveawayManagePicker.js';

export default {
    slashOnly: true,
    adminOnly: false,
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage giveaways.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(option => option
            .setName('create')
            .setDescription('Open the giveaway builder to create and set a giveaway.'))
        .addSubcommand(option => option
            .setName('manage')
            .setDescription('Select a giveaway and open owner-only management.')),

    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'create') {
            return openGiveawayBuilder(interaction);
        }
        return showGiveawayManagePicker(interaction, interaction.client);
    },
};
