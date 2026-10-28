import { SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const MINE_COOLDOWN = 60 * 60 * 1000;
const BASE_MIN_REWARD = 400;
const BASE_MAX_REWARD = 1200;
const PICKAXE_MULTIPLIER = 1.2;
const DIAMOND_PICKAXE_MULTIPLIER = 2.0;

const MINE_LOCATIONS = [
    "abandoned gold mine",
    "dark, damp cave",
    "backyard rock quarry",
    "volcanic obsidian vent",
    "deep-sea mineral trench",
];

function applyMineReward(userData) {
    const now = Date.now();
    const lastMine = userData.lastMine || 0;
    const hasDiamondPickaxe = (userData.inventory?.["diamond_pickaxe"] || 0) > 0;
    const hasPickaxe = (userData.inventory?.["pickaxe"] || 0) > 0;
    if (now < lastMine + MINE_COOLDOWN) {
        const remaining = lastMine + MINE_COOLDOWN - now;
        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        throw createError(
            "Mining cooldown active", ErrorTypes.RATE_LIMIT,
            `Your pickaxe is cooling down. Wait for **${hours}h ${minutes}m** before mining again.`,
            { remaining, cooldownType: 'mine' }
        );
    }
    const baseEarned = Math.floor(Math.random() * (BASE_MAX_REWARD - BASE_MIN_REWARD + 1)) + BASE_MIN_REWARD;
    let finalEarned = baseEarned;
    let multiplierMessage = "";
    if (hasDiamondPickaxe) {
        finalEarned = Math.floor(baseEarned * DIAMOND_PICKAXE_MULTIPLIER);
        multiplierMessage = `\n💎 **Diamond Pickaxe Bonus: +100%**`;
    } else if (hasPickaxe) {
        finalEarned = Math.floor(baseEarned * PICKAXE_MULTIPLIER);
        multiplierMessage = `\n⛏️ **Pickaxe Bonus: +20%**`;
    }
    const location = MINE_LOCATIONS[Math.floor(Math.random() * MINE_LOCATIONS.length)];
    const newWallet = (userData.wallet || 0) + finalEarned;
    if (!Number.isSafeInteger(newWallet) || newWallet < 0) {
        throw createError(
            "Invalid balance state", ErrorTypes.VALIDATION,
            "Operation would create an invalid account balance."
        );
    }
    userData.wallet = newWallet;
    userData.lastMine = now;
    return { finalEarned, multiplierMessage, location };
}

export default {
    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Go mining to earn money'),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        let userData;
        let reward;

        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyMineReward(current),
            );
            userData = mutation.account;
            reward = mutation.result;
        } else {
            userData = await getEconomyData(client, guildId, userId);
            reward = applyMineReward(userData);
            await setEconomyData(client, guildId, userId, userData);
        }

        const embed = successEmbed(
            "💰 Mining Expedition Successful!",
            `You explored a **${reward.location}** and managed to find minerals worth **$${reward.finalEarned.toLocaleString()}**!${reward.multiplierMessage}`,
        )
            .addFields({
                name: "New Cash Balance",
                value: `$${userData.wallet.toLocaleString()}`,
                inline: true,
            })
            .setFooter({ text: `Next mine available in 1 hour.` });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'mine' })
};
