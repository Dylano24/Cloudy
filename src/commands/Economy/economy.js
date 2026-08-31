import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import economyDashboard from './modules/economy_dashboard.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
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
            const rawAmount = interaction.options.getString('amount').trim();
            if (!/^\d+$/.test(rawAmount)) {
                throw new Error('Enter a whole positive number.');
            }
            const amount = Number(rawAmount);
            if (!Number.isSafeInteger(amount) || amount < 1) {
                throw new Error(`Enter an amount from 1 to ${Number.MAX_SAFE_INTEGER.toLocaleString()}.`);
            }
            const data = await getEconomyData(client, interaction.guildId, interaction.user.id);
            if (data.wallet > Number.MAX_SAFE_INTEGER - amount) {
                throw new Error('That amount would exceed the maximum safe economy balance.');
            }
            data.wallet += amount;
            const saved = await setEconomyData(client, interaction.guildId, interaction.user.id, data);
            if (!saved) throw new Error('Your balance could not be saved.');
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Cash added', `Added **$${amount.toLocaleString()}** to your cash.\nNew cash balance: **$${data.wallet.toLocaleString()}**.`)],
                components: [],
            });
        }
    }
};
