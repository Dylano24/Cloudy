import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { botConfig } from '../../config/bot.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const COOLDOWN = 30 * 60 * 1000;
const MIN_WIN = Number(botConfig?.economy?.begMin) || 50;
const MAX_WIN = Number(botConfig?.economy?.begMax) || 200;
const SUCCESS_CHANCE = 0.7;

function applyBegReward(userData) {
    const remainingTime = (userData.lastBeg || 0) + COOLDOWN - Date.now();
    if (remainingTime > 0) {
        const minutes = Math.floor(remainingTime / 60000);
        const seconds = Math.floor((remainingTime % 60000) / 1000);
        const timeMessage = minutes > 0 ? `${minutes} minute(s)` : `${seconds} second(s)`;
        throw createError(
            "Beg cooldown active",
            ErrorTypes.RATE_LIMIT,
            `You are tired from begging! Try again in **${timeMessage}**.`,
            { remainingTime, minutes, seconds, cooldownType: 'beg' }
        );
    }

    const success = Math.random() < SUCCESS_CHANCE;
    const amountWon = success ? Math.floor(Math.random() * (MAX_WIN - MIN_WIN + 1)) + MIN_WIN : 0;
    const nextWallet = (userData.wallet || 0) + amountWon;
    if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
        throw createError(
            "Invalid balance state", ErrorTypes.VALIDATION,
            "Operation would create an invalid account balance."
        );
    }
    userData.wallet = nextWallet;
    userData.lastBeg = Date.now();
    return { success, amountWon };
}

export default {
    data: new SlashCommandBuilder()
        .setName('beg')
        .setDescription('Beg for a small amount of money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;

        let outcome;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyBegReward(current),
            );
            outcome = mutation.result;
        } else {
            const userData = await getEconomyData(client, guildId, userId);
            if (!userData) {
                throw createError(
                    "Failed to load economy data",
                    ErrorTypes.DATABASE,
                    "Failed to load your economy data. Please try again later.",
                    { userId, guildId }
                );
            }
            outcome = applyBegReward(userData);
            await setEconomyData(client, guildId, userId, userData);
        }

        let replyEmbed;
        if (outcome.success) {
            const amountWon = outcome.amountWon;
            const successMessages = [
                `A kind stranger drops **$${amountWon.toLocaleString()}** into your cup.`,
                `You spotted an unattended wallet! You grab **$${amountWon.toLocaleString()}** and run.`,
                `Someone took pity on you and gave **$${amountWon.toLocaleString()}**!`,
                `You found **$${amountWon.toLocaleString()}** under a park bench.`,
            ];
            replyEmbed = successEmbed(
                'Begging Successful',
                successMessages[Math.floor(Math.random() * successMessages.length)]
            );
        } else {
            const failMessages = [
                "The police chased you off. You got nothing.",
                "Someone yelled, 'Get a job!' and walked past.",
                "A squirrel stole the single coin you had.",
                "You tried to beg, but you were too embarrassed and gave up.",
            ];
            replyEmbed = warningEmbed(
                'Insufficient Funds',
                failMessages[Math.floor(Math.random() * failMessages.length)]
            );
        }

        await InteractionHelper.safeEditReply(interaction, { embeds: [replyEmbed] });
    }, { command: 'beg' })
};
