import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botConfig } from '../../config/bot.js';

const WORK_COOLDOWN = botConfig.economy?.cooldowns?.work ?? 30 * 60 * 1000;
const MIN_WORK_AMOUNT = botConfig.economy?.workMin ?? 10;
const MAX_WORK_AMOUNT = botConfig.economy?.workMax ?? 100;
const LAPTOP_MULTIPLIER = 1.5;
const WORK_JOBS = [
    "Software Developer",
    "Barista",
    "Janitor",
    "YouTuber",
    "Discord Bot Developer",
    "Cashier",
    "Pizza Delivery Driver",
    "Librarian",
    "Gardener",
    "Data Analyst",
];

// This is called while the PostgreSQL account row is locked. Cooldowns,
// consumables and wallet changes must commit (or roll back) together.
function applyWorkReward(userData) {
    const now = Date.now();
    const lastWork = userData.lastWork || 0;
    const inventory = userData.inventory || {};
    const extraWorkShifts = inventory["extra_work"] || 0;
    const hasLaptop = (inventory["laptop"] || 0) > 0;
    let usedConsumable = false;

    if (now < lastWork + WORK_COOLDOWN) {
        if (extraWorkShifts > 0) {
            inventory["extra_work"] = extraWorkShifts - 1;
            usedConsumable = true;
        } else {
            const remaining = lastWork + WORK_COOLDOWN - now;
            throw createError(
                "Work cooldown active",
                ErrorTypes.RATE_LIMIT,
                `You're working too fast! Wait **${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m** before working again.`,
                { timeRemaining: remaining, cooldownType: 'work' }
            );
        }
    }

    let earned = Math.floor(Math.random() * (MAX_WORK_AMOUNT - MIN_WORK_AMOUNT + 1)) + MIN_WORK_AMOUNT;
    const job = WORK_JOBS[Math.floor(Math.random() * WORK_JOBS.length)];
    if (hasLaptop) earned = Math.floor(earned * LAPTOP_MULTIPLIER);
    const nextWallet = (userData.wallet || 0) + earned;
    if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
        throw createError(
            "Invalid balance state",
            ErrorTypes.VALIDATION,
            "Operation would create an invalid account balance."
        );
    }

    userData.inventory = inventory;
    userData.wallet = nextWallet;
    userData.lastWork = now;
    return { job, earned, usedConsumable, hasLaptop, now };
}

export default {
    data: new SlashCommandBuilder()
        .setName('work')
        .setDescription('Work to earn some money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        logger.debug(`[ECONOMY] Work command started for ${userId}`, { userId, guildId });

        let account;
        let reward;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            // Each simultaneous /work sees the latest account after a row lock,
            // so the lastWork cooldown and extra_work item cannot be double used.
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(), current => applyWorkReward(current),
            );
            account = mutation.account;
            reward = mutation.result;
        } else {
            // Preserve legacy behavior for non-Postgres development databases.
            account = await getEconomyData(client, guildId, userId);
            if (!account) {
                throw createError(
                    "Failed to load economy data for work",
                    ErrorTypes.DATABASE,
                    "Failed to load your economy data. Please try again later.",
                    { userId, guildId }
                );
            }
            reward = applyWorkReward(account);
            await setEconomyData(client, guildId, userId, account);
        }

        const { job, earned, usedConsumable, hasLaptop, now } = reward;
        logger.info(`[ECONOMY_TRANSACTION] Work completed`, {
            userId,
            guildId,
            amount: earned,
            job,
            usedConsumable,
            hasLaptop,
            newWallet: account.wallet,
            timestamp: new Date().toISOString()
        });

        const multiplierMessage = hasLaptop ? "\n💻 **Laptop Bonus:** +50% earnings!" : "";
        const embed = successEmbed(
            "💼 Work Complete!",
            `You worked as a **${job}** and earned **$${earned.toLocaleString()}**!${multiplierMessage}`
        )
            .addFields(
                {
                    name: "New Balance",
                    value: `$${account.wallet.toLocaleString()}`,
                    inline: true,
                },
                {
                    name: "Next Work",
                    value: `<t:${Math.floor((now + WORK_COOLDOWN) / 1000)}:R>`,
                    inline: true,
                }
            )
            .setFooter({
                text: `Requested by ${interaction.user.tag}`,
                iconURL: interaction.user.displayAvatarURL(),
            });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'work' })
};
