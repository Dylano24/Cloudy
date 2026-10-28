import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { CLOUDY_LOGO_URL } from '../../services/cloudyLogoService.js';
import { getEconomyData, setEconomyData, getInitialEconomyData } from '../../utils/economy.js';
import { enforceDedicatedCommandChannel } from '../../services/dedicatedChannelService.js';
import { buildGamblingCommandListText } from '../../config/gamblingCommands.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const BASE_WIN_CHANCE = 0.4;
const CLOVER_WIN_BONUS = 0.1;
const CHARM_WIN_BONUS = 0.08;
const PAYOUT_MULTIPLIER = 2.0;
const GAMBLE_COOLDOWN = 5 * 60 * 1000;

function buildGamblingCommandList() {
    return infoEmbed(
        'Gambling & Games',
        buildGamblingCommandListText(),
    ).setThumbnail(CLOUDY_LOGO_URL);
}

function applyGamble(userData, betAmount) {
    const now = Date.now();
    const lastGamble = userData.lastGamble || 0;
    if (now < lastGamble + GAMBLE_COOLDOWN) {
        const remaining = lastGamble + GAMBLE_COOLDOWN - now;
        const minutes = Math.floor(remaining / (1000 * 60));
        const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
        throw createError(
            'Gamble cooldown active', ErrorTypes.RATE_LIMIT,
            `You need to cool down before gambling again. Wait **${minutes}m ${seconds}s**.`,
            { remaining, cooldownType: 'gamble' }
        );
    }
    if (!Number.isSafeInteger(betAmount) || betAmount < 1 || userData.wallet < betAmount) {
        throw createError(
            'Insufficient cash for gamble',
            ErrorTypes.VALIDATION,
            `You only have $${userData.wallet.toLocaleString()} cash, but you are trying to bet $${betAmount.toLocaleString()}.`,
            { required: betAmount, current: userData.wallet, titleOverride: 'Not enough money' }
        );
    }

    const inventory = userData.inventory || {};
    const cloverCount = inventory['lucky_clover'] || 0;
    const charmCount = inventory['lucky_charm'] || 0;
    let winChance = BASE_WIN_CHANCE;
    let cloverMessage = '';
    let usedClover = false;
    let usedCharm = false;

    if (cloverCount > 0) {
        winChance += CLOVER_WIN_BONUS;
        inventory['lucky_clover'] = cloverCount - 1;
        cloverMessage = '\n🍀 **Lucky Clover Consumed:** Your win chance was boosted!';
        usedClover = true;
    } else if (charmCount > 0) {
        winChance += CHARM_WIN_BONUS;
        inventory['lucky_charm'] = charmCount - 1;
        cloverMessage = `\n🍀 **Lucky Charm Used (${charmCount - 1} uses remaining):** Your win chance was boosted!`;
        usedCharm = true;
    }

    const win = Math.random() < winChance;
    const amountWon = win ? Math.floor(betAmount * PAYOUT_MULTIPLIER) : 0;
    const cashChange = win ? amountWon - betAmount : -betAmount;
    const nextWallet = (userData.wallet || 0) + cashChange;
    if (!Number.isSafeInteger(nextWallet) || nextWallet < 0) {
        throw createError(
            'Invalid balance state', ErrorTypes.VALIDATION,
            'Operation would create an invalid account balance.'
        );
    }
    userData.wallet = nextWallet;
    userData.inventory = inventory;
    userData.lastGamble = now;
    return { win, amountWon, usedClover, usedCharm, winChance, cloverMessage };
}

export default {
    data: new SlashCommandBuilder()
        .setName('gamble')
        .setDescription('View Gambling & Games commands or gamble your money')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to gamble')
                .setRequired(false)
                .setMinValue(1)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        await enforceDedicatedCommandChannel(interaction, 'gambling');

        const betAmount = interaction.options.getInteger('amount');
        if (betAmount === null) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [buildGamblingCommandList()],
                components: [],
            });
            return;
        }

        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        let userData;
        let outcome;
        if (client.db?.getConnectionType?.() === 'postgresql'
            && typeof client.db.mutateEconomyAccount === 'function') {
            const mutation = await client.db.mutateEconomyAccount(
                guildId, userId, getInitialEconomyData(),
                current => applyGamble(current, betAmount),
            );
            userData = mutation.account;
            outcome = mutation.result;
        } else {
            userData = await getEconomyData(client, guildId, userId);
            outcome = applyGamble(userData, betAmount);
            await setEconomyData(client, guildId, userId, userData);
        }

        let resultEmbed;
        if (outcome.win) {
            resultEmbed = successEmbed(
                '🎉 You Won!',
                `You successfully gambled and turned your **$${betAmount.toLocaleString()}** bet into **$${outcome.amountWon.toLocaleString()}**!${outcome.cloverMessage}`,
            );
        } else {
            resultEmbed = warningEmbed(
                '💔 You Lost...',
                `The dice rolled against you. You lost your **$${betAmount.toLocaleString()}** bet.`,
            );
        }
        resultEmbed.setThumbnail(CLOUDY_LOGO_URL);
        resultEmbed.addFields({
            name: 'New Cash Balance',
            value: `$${userData.wallet.toLocaleString()}`,
            inline: true,
        });

        if (outcome.usedClover) {
            resultEmbed.setFooter({
                text: `You have ${userData.inventory['lucky_clover']} Lucky Clovers left. Win chance was ${Math.round(outcome.winChance * 100)}%.`,
            });
        } else if (outcome.usedCharm) {
            resultEmbed.setFooter({
                text: `You have ${userData.inventory['lucky_charm']} Lucky Charm uses left. Win chance was ${Math.round(outcome.winChance * 100)}%.`,
            });
        } else {
            resultEmbed.setFooter({
                text: `Next gamble available in 5 minutes. Base win chance: ${Math.round(BASE_WIN_CHANCE * 100)}%.`,
            });
        }
        await InteractionHelper.safeEditReply(interaction, {
            embeds: [resultEmbed], components: [],
        });
    }, { command: 'gamble' })
};
