import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import economyDashboard from './modules/economy_dashboard.js';
import { canGrantCurrency, grantCurrency, parseCurrencyAmount } from '../../services/currencyGrantService.js';
import { createEmbed } from '../../utils/embeds.js';
import { successEmbed } from '../../utils/embeds.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('economy')
        .setDescription('Economy management commands')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the economy management dashboard')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('give')
                .setDescription('Give yourself cash')
                .addStringOption(option => option.setName('amount').setDescription('Amount of cash to add').setRequired(true))
        ),
    category: 'Economy',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, {
            flags: MessageFlags.Ephemeral,
        });
        if (!deferred) return;

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'dashboard') {
            await economyDashboard.execute(interaction, config, client);
            return;
        }

        if (subcommand === 'give') {
            if (!canGrantCurrency(interaction)) {
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({
                        title: 'Permission denied',
                        description: 'Only Cloudy owners can give currency.',
                        color: 'error',
                    })],
                });
                return;
            }
            try {
                const amount = parseCurrencyAmount(interaction.options.getString('amount'));
                const newCash = await grantCurrency(client, interaction.guildId, interaction.user.id, amount);
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed('Cash added',
                        `Added **$${amount.toLocaleString()}** to your cash.\nNew cash balance: **$${newCash.toLocaleString()}**.`)],
                    components: [],
                });
            } catch (error) {
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: 'Something went wrong', description: error.message, color: 'error' })],
                });
            }
        }
    }
};
