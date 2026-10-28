import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const CRIME_COOLDOWN = 60 * 60 * 1000;
const JAIL_TIME = 2 * 60 * 60 * 1000;
const FINE_RATE = 0.2;

const CRIME_TYPES = [
    { name: "Pickpocketing", min: 100, max: 500, risk: 0.3 },
    { name: "Burglary", min: 300, max: 1000, risk: 0.4 },
    { name: "Bank Heist", min: 1000, max: 5000, risk: 0.6 },
    { name: "Art Theft", min: 2000, max: 10000, risk: 0.7 },
    { name: "Cybercrime", min: 5000, max: 20000, risk: 0.8 },
];

function applyCrime(userData, crime) {
    const now = Date.now();
    const lastCrime = userData.cooldowns?.crime || 0;
    const isJailed = userData.jailedUntil && userData.jailedUntil > now;
    if (isJailed) {
        const timeLeft = Math.ceil((userData.jailedUntil - now) / (1000 * 60));
        throw createError(
            "User is in jail", ErrorTypes.RATE_LIMIT,
            `You're in jail for ${timeLeft} more minutes!`,
            { jailTimeRemaining: userData.jailedUntil - now }
        );
    }
    if (now < lastCrime + CRIME_COOLDOWN) {
        const timeLeft = Math.ceil((lastCrime + CRIME_COOLDOWN - now) / (1000 * 60));
        throw createError(
            "Crime cooldown active", ErrorTypes.RATE_LIMIT,
            `You need to wait ${timeLeft} more minutes before committing another crime.`,
            { remaining: lastCrime + CRIME_COOLDOWN - now, cooldownType: 'crime' }
        );
    }

    const isSuccess = Math.random() > crime.risk;
    const amountEarned = isSuccess
        ? Math.floor(Math.random() * (crime.max - crime.min + 1)) + crime.min
        : 0;
    userData.cooldowns = userData.cooldowns || {};
    userData.cooldowns.crime = now;

    if (isSuccess) {
        const nextWallet = (userData.wallet || 0) + amountEarned;
        if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
            throw createError(
                "Invalid balance state", ErrorTypes.VALIDATION,
                "Operation would create an invalid account balance."
            );
        }
        userData.wallet = nextWallet;
        return { isSuccess, amountEarned };
    }

    const potentialHaul = Math.floor((crime.min + crime.max) / 2);
    const fine = Math.min(Math.floor(potentialHaul * FINE_RATE), userData.wallet || 0);
    userData.wallet = Math.max(0, (userData.wallet || 0) - fine);
    userData.jailedUntil = now + JAIL_TIME;
    return { isSuccess, fine };
}

export default {
    data: new SlashCommandBuilder()
        .setName('crime')
        .setDescription('Commit a crime to earn money (risky)')
        .addStringOption(option =>
            option
                .setName('type')
                .setDescription('Type of crime to commit')
                .setRequired(true)
                .addChoices(
                    { name: 'Pickpocketing', value: 'pickpocketing' },
                    { name: 'Burglary', value: 'burglary' },
                    { name: 'Bank Heist', value: 'bank-heist' },
                    { name: 'Art Theft', value: 'art-theft' },
                    { name: 'Cybercrime', value: 'cybercrime' },
                )
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        await InteractionHelper.safeDefer(interaction);
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const crimeType = interaction.options.getString("type").toLowerCase();
        const crime = CRIME_TYPES.find(
            c => c.name.toLowerCase().replace(/\s+/g, '-') === crimeType
        );
        if (!crime) {
            throw createError(
                "Invalid crime type", ErrorTypes.VALIDATION,
                "Please select a valid crime type.",
                { crimeType }
            );
        }

        let outcome;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyCrime(current, crime),
            );
            outcome = mutation.result;
        } else {
            const userData = await getEconomyData(client, guildId, userId);
            outcome = applyCrime(userData, crime);
            await setEconomyData(client, guildId, userId, userData);
        }

        if (outcome.isSuccess) {
            const embed = successEmbed(
                "🕵️ Crime Successful!",
                `You successfully committed ${crime.name} and earned **${outcome.amountEarned}** coins!`
            );
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        } else {
            const embed = warningEmbed(
                "🚔 Crime Failed!",
                `You were caught while attempting ${crime.name} and have been sent to jail! `
                + `You were fined ${outcome.fine.toLocaleString()} coins and will be in jail for 2 hours.`
            );
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    }, { command: 'crime' })
};
