import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

function applyWithdrawal(userData, requestedAmount, userId) {
    if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
        throw createError(
            "Invalid withdrawal amount", ErrorTypes.VALIDATION,
            "You must withdraw a positive amount.",
            { amount: requestedAmount, userId }
        );
    }
    const withdrawAmount = Math.min(requestedAmount, userData.bank || 0);
    if (withdrawAmount === 0) {
        throw createError(
            "Empty bank account", ErrorTypes.VALIDATION,
            "Your bank account is empty.",
            { userId, bankBalance: userData.bank }
        );
    }
    const nextWallet = (userData.wallet || 0) + withdrawAmount;
    if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
        throw createError(
            "Invalid balance state", ErrorTypes.VALIDATION,
            "Operation would create an invalid account balance."
        );
    }
    userData.wallet = nextWallet;
    userData.bank -= withdrawAmount;
    return withdrawAmount;
}

export default {
    data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('Withdraw money from your bank to your wallet')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to withdraw')
                .setRequired(true)
                .setMinValue(1)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        await InteractionHelper.safeDefer(interaction);

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const amountInput = interaction.options.getInteger("amount");

        let userData;
        let withdrawAmount;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyWithdrawal(current, amountInput, userId),
            );
            userData = mutation.account;
            withdrawAmount = mutation.result;
        } else {
            userData = await getEconomyData(client, guildId, userId);
            if (!userData) {
                throw createError(
                    "Failed to load economy data",
                    ErrorTypes.DATABASE,
                    "Failed to load your economy data. Please try again later.",
                    { userId, guildId }
                );
            }
            withdrawAmount = applyWithdrawal(userData, amountInput, userId);
            await setEconomyData(client, guildId, userId, userData);
        }

        const embed = successEmbed(
            'Withdrawal Successful',
            `You successfully withdrew **$${withdrawAmount.toLocaleString()}** from your bank.`
        )
            .addFields(
                {
                    name: "New Cash Balance",
                    value: `$${userData.wallet.toLocaleString()}`,
                    inline: true,
                },
                {
                    name: "New Bank Balance",
                    value: `$${userData.bank.toLocaleString()}`,
                    inline: true,
                },
            );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'withdraw' })
};
