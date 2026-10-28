import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { successEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getMaxBankCapacity, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

// Calculate both balances and all limits from the account row currently
// locked in PostgreSQL, not a snapshot from before another /deposit.
function applyDeposit(userData, amountInput, userId) {
    const maxBank = getMaxBankCapacity(userData);
    const warnings = [];
    const all = amountInput.toLowerCase() === "all";
    let depositAmount;

    if (all) {
        depositAmount = userData.wallet;
    } else {
        depositAmount = parseInt(amountInput);
        if (!Number.isSafeInteger(depositAmount) || depositAmount <= 0) {
            throw createError(
                "Invalid deposit amount",
                ErrorTypes.VALIDATION,
                `Please enter a valid number or 'all'. You entered: \`${amountInput}\``,
                { amountInput, userId }
            );
        }
    }

    if (depositAmount === 0) {
        throw createError(
            "Zero deposit amount",
            ErrorTypes.VALIDATION,
            "You have no cash to deposit.",
            { userId, walletBalance: userData.wallet }
        );
    }

    if (depositAmount > userData.wallet) {
        depositAmount = userData.wallet;
        warnings.push(`You tried to deposit more than you have. Depositing your remaining cash: **$${depositAmount.toLocaleString()}**`);
    }

    const availableSpace = maxBank - userData.bank;
    if (availableSpace <= 0) {
        throw createError(
            "Bank is full",
            ErrorTypes.VALIDATION,
            `Your bank is currently full (Max Capacity: $${maxBank.toLocaleString()}). Purchase a **Bank Upgrade** to increase your limit.`,
            { maxBank, currentBank: userData.bank, userId }
        );
    }

    if (depositAmount > availableSpace) {
        depositAmount = availableSpace;
        if (!all) {
            warnings.push(`You only had space for **$${depositAmount.toLocaleString()}** in your bank account (Max: $${maxBank.toLocaleString()}). The rest remains in your cash.`);
        }
    }

    if (depositAmount === 0) {
        throw createError(
            "No space or cash for deposit",
            ErrorTypes.VALIDATION,
            "The amount you tried to deposit was either 0 or exceeded your bank capacity after checking your cash balance.",
            { depositAmount, availableSpace, walletBalance: userData.wallet }
        );
    }

    const nextWallet = userData.wallet - depositAmount;
    const nextBank = userData.bank + depositAmount;
    if (!Number.isSafeInteger(nextWallet) || nextWallet < 0
        || !Number.isSafeInteger(nextBank) || nextBank < 0 || nextBank > maxBank) {
        throw createError(
            "Invalid balance state",
            ErrorTypes.VALIDATION,
            "Operation would create an invalid account balance."
        );
    }
    userData.wallet = nextWallet;
    userData.bank = nextBank;
    return { depositAmount, maxBank, warnings };
}

export default {
    data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('Deposit money from your wallet into your bank')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to deposit (number or "all")')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const amountInput = interaction.options.getString("amount");

        let userData;
        let result;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyDeposit(current, amountInput, userId),
            );
            userData = mutation.account;
            result = mutation.result;
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
            result = applyDeposit(userData, amountInput, userId);
            await setEconomyData(client, guildId, userId, userData);
        }

        // Do not send Discord follow-ups while holding a database row lock.
        // Warnings only describe successfully persisted balance adjustments.
        for (const message of result.warnings) {
            await interaction.followUp({
                embeds: [buildUserErrorEmbed('validation', message)],
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }

        const embed = successEmbed(
            'Deposit Successful',
            `You successfully deposited **$${result.depositAmount.toLocaleString()}** into your bank.`
        )
            .addFields(
                {
                    name: "New Cash Balance",
                    value: `$${userData.wallet.toLocaleString()}`,
                    inline: true,
                },
                {
                    name: "New Bank Balance",
                    value: `$${userData.bank.toLocaleString()} / $${result.maxBank.toLocaleString()}`,
                    inline: true,
                },
            );

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'deposit' })
};
