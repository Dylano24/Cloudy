import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getEconomyPrefix } from '../../utils/database.js';
import { readGuildEconomyValues } from '../../utils/economy.js';

export async function buildEconomyLeaderboardEmbed(client, guildId, userId) {

    logger.debug(`[ECONOMY] Leaderboard requested`, { guildId });

    const prefix = getEconomyPrefix(guildId);

    let allKeys = await client.db.list(prefix);

    if (!Array.isArray(allKeys)) {
        allKeys = [];
    }

    if (allKeys.length === 0) {
        throw createError(
            "No economy data found",
            ErrorTypes.VALIDATION,
            "No economy data found for this server."
        );
    }

    // One whole-guild read instead of one database query per account. Values
    // and their order (and therefore tie order) are unchanged.
    const guild = client.guilds?.cache?.get(guildId) || await client.guilds?.fetch?.(guildId);
    if (!guild?.members?.fetch) {
        throw createError('Current server membership unavailable', ErrorTypes.VALIDATION,
            'The current server member list could not be verified. Please try again.');
    }
    // Fetch the actual current membership rather than trusting a partial or
    // stale cache. Read balances in parallel and filter before ranking/limiting.
    const [values, members] = await Promise.all([
        readGuildEconomyValues(client, guildId, allKeys),
        guild.members.fetch(),
    ]);
    const allUserData = allKeys.map((key, index) => {
        const userId = key.replace(prefix, "");
        const userData = values[index];

        if (userData && members.has(userId)) {
            return {
                userId: userId,
                net_worth: (userData.wallet || 0) + (userData.bank || 0),
            };
        }

        return null;
    }).filter(Boolean);

    allUserData.sort((a, b) => b.net_worth - a.net_worth);

    const topUsers = allUserData.slice(0, 10);
    const userRank =
        allUserData.findIndex((u) => u.userId === userId) +
        1;
    const leaderboardEntries = [];

    for (let i = 0; i < topUsers.length; i++) {
        const user = topUsers[i];
        const rank = i + 1;

        leaderboardEntries.push(
            `**#${rank}** <@${user.userId}> - 🏦 ${user.net_worth.toLocaleString()}`,
        );
    }

    logger.info(`[ECONOMY] Leaderboard generated`, { 
        guildId, 
        userCount: allUserData.length,
        userRank 
    });

    const description = leaderboardEntries.length > 0
        ? leaderboardEntries.join("\n")
        : "No economy data is available for this server yet.";

    return createEmbed({
        title: `Economy leaderboard`,
        description,
        footer: `Your Rank: ${userRank > 0 ?`#${userRank}`: "No ranking data available"}`,
    });

}

export default {
    data: new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("View the server's top 10 richest users.")
        .setDMPermission(false),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const embed = await buildEconomyLeaderboardEmbed(client, interaction.guildId, interaction.user.id);

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'leaderboard' })
};
