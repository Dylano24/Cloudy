import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { BotConfig } from '../../config/bot.js';

const ROB_COOLDOWN = BotConfig.economy?.cooldowns?.rob ?? 4 * 60 * 60 * 1000;
const BASE_ROB_SUCCESS_CHANCE = BotConfig.economy?.robSuccessRate ?? 0.4;
const ROB_PERCENTAGE = 0.15;
const FINE_PERCENTAGE = 0.1;

function applyRobbery(robberData, victimData, victimUser) {
    // Called after both accounts have been row-locked by PostgreSQL.
    // Recheck the cooldown, victim's balance and safe with the current data.
    const now = Date.now();
    const lastRob = robberData.lastRob || 0;
    if (now < lastRob + ROB_COOLDOWN) {
        const remaining = lastRob + ROB_COOLDOWN - now;
        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        throw createError(
            "Robbery cooldown active",
            ErrorTypes.RATE_LIMIT,
            `You need to lay low. Wait **${hours}h ${minutes}m** before attempting another robbery.`,
            { remaining, hours, minutes, cooldownType: 'rob' }
        );
    }
    if (victimData.wallet < 500) {
        throw createError(
            "Victim too poor",
            ErrorTypes.VALIDATION,
            `${victimUser.username} is too poor. They need at least $500 cash to be worth robbing.`,
            { victimWallet: victimData.wallet, required: 500 }
        );
    }

    if ((victimData.inventory?.["personal_safe"] || 0) > 0) {
        robberData.lastRob = now;
        return { kind: 'blocked' };
    }

    const success = Math.random() < BASE_ROB_SUCCESS_CHANCE;
    let amount;
    if (success) {
        amount = Math.floor(victimData.wallet * ROB_PERCENTAGE);
        const nextWallet = (robberData.wallet || 0) + amount;
        if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
            throw createError(
                "Invalid balance state",
                ErrorTypes.VALIDATION,
                "Operation would create an invalid account balance."
            );
        }
        robberData.wallet = nextWallet;
        victimData.wallet -= amount;
    } else {
        amount = Math.floor((robberData.wallet || 0) * FINE_PERCENTAGE);
        robberData.wallet = Math.max(0, (robberData.wallet || 0) - amount);
    }
    robberData.lastRob = now;
    return { kind: success ? 'success' : 'failure', amount };
}

export default {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Attempt to rob another user (very risky)')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to rob')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const robberId = interaction.user.id;
        const victimUser = interaction.options.getUser("user");
        const guildId = interaction.guildId;

        if (robberId === victimUser.id) {
            throw createError(
                "Cannot rob self",
                ErrorTypes.VALIDATION,
                "You cannot rob yourself.",
                { robberId, victimId: victimUser.id }
            );
        }
        if (victimUser.bot) {
            throw createError(
                "Cannot rob bot",
                ErrorTypes.VALIDATION,
                "You cannot rob a bot.",
                { victimId: victimUser.id, isBot: true }
            );
        }

        let robberData;
        let victimData;
        let outcome;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccounts === 'function') {
            const transaction = await client.db.mutateEconomyAccounts(
                guildId, [robberId, victimUser.id], getInitialEconomyData(), accounts => {
                    const robber = accounts.get(String(robberId));
                    const victim = accounts.get(String(victimUser.id));
                    if (!robber || !victim) throw new Error('Missing locked robbery accounts');
                    return applyRobbery(robber, victim, victimUser);
                },
            );
            robberData = transaction.accounts.get(String(robberId));
            victimData = transaction.accounts.get(String(victimUser.id));
            outcome = transaction.result;
        } else {
            robberData = await getEconomyData(client, guildId, robberId);
            victimData = await getEconomyData(client, guildId, victimUser.id);
            if (!robberData || !victimData) {
                throw createError(
                    "Failed to load economy data",
                    ErrorTypes.DATABASE,
                    "Failed to load economy data. Please try again later.",
                    { robberId: !!robberData, victimId: !!victimData, guildId }
                );
            }
            outcome = applyRobbery(robberData, victimData, victimUser);
            await setEconomyData(client, guildId, robberId, robberData);
            // A failed/blocked robbery cannot write a stale victim account.
            if (outcome.kind === 'success') {
                await setEconomyData(client, guildId, victimUser.id, victimData);
            }
        }

        if (outcome.kind === 'blocked') {
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    warningEmbed(
                        'Robbery blocked',
                        `${victimUser.username} was prepared! Your attempt failed because they own a **Personal Safe**. You got away clean but didn't gain anything.`
                    )
                ],
            });
        }

        const resultEmbed = outcome.kind === 'success'
            ? successEmbed(
                'Robbery successful',
                `You successfully stole **$${outcome.amount.toLocaleString()}** from ${victimUser.username}!`
            )
            : buildUserErrorEmbed(
                'unknown',
                `You failed the robbery and were caught! You were fined **$${outcome.amount.toLocaleString()}** of your own cash.`,
                { titleOverride: 'Robbery failed' }
            );

        resultEmbed
            .addFields(
                {
                    name: `Your new cash (${interaction.user.username})`,
                    value: `$${robberData.wallet.toLocaleString()}`,
                    inline: true,
                },
                {
                    name: `Victim's new cash (${victimUser.username})`,
                    value: `$${victimData.wallet.toLocaleString()}`,
                    inline: true,
                },
            )
            .setFooter({ text: `Next robbery available in ${Math.ceil(ROB_COOLDOWN / (60 * 60 * 1000))} hours.` });

        await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
    }, { command: 'rob' })
};
