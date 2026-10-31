import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { openManagePanel } from '../../handlers/giveawayButtons.js';
import { canManageGiveawaysAsOwner } from '../../services/giveawayActions.js';
import { giveawayWarning } from '../../handlers/giveawayButtons.js';
import { openGiveawayBuilder } from '../../services/giveawayBuilderService.js';

export default {
    slashOnly: true,
    adminOnly: false,
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage giveaways.')
        .addSubcommand(option => option
            .setName('create')
            .setDescription('Open the giveaway builder to create and set a giveaway.'))
        .addSubcommand(option => option
            .setName('manage')
            .setDescription('Open private giveaway management (Owner role only).')
            .addStringOption(input => input
                .setName('messageid').setDescription('Giveaway message ID or message link.')
                .setRequired(true))),

    async execute(interaction) {
        if (interaction.options.getSubcommand() === 'create') {
            return openGiveawayBuilder(interaction);
        }
        if (!canManageGiveawaysAsOwner(interaction.member, interaction.guild)) {
            return interaction.reply({ embeds: [giveawayWarning('Only the Owner role can manage giveaways.')], flags: MessageFlags.Ephemeral });
        }
        const raw = String(interaction.options.getString('messageid') || '').trim();
        const parsed = raw.match(/^(?:https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/\d{17,20}\/)?(\d{17,20})\/?$/);
        const messageId = parsed && (!parsed[1] || parsed[1] === interaction.guildId) ? parsed[2] : null;
        if (!messageId) {
            return interaction.reply({ embeds: [giveawayWarning('Enter a valid giveaway message ID or a link from this server.')], flags: MessageFlags.Ephemeral });
        }
        return openManagePanel(interaction, interaction.client, messageId);
    },
};
