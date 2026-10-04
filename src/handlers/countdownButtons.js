import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
function createControlButtons(countdownId, isPaused = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`countdown_pause:${countdownId}`)
            .setLabel(isPaused ? "▶️ Resume" : "⏸️ Pause")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`countdown_cancel:${countdownId}`)
            .setLabel("❌ Cancel")
            .setStyle(ButtonStyle.Danger),
    );
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    return [
        h > 0 ? h.toString().padStart(2, "0") : null,
        m.toString().padStart(2, "0"),
        s.toString().padStart(2, "0"),
    ]
        .filter(Boolean)
        .join(":");
}

function startCountdown(countdownId, countdownData, activeCountdowns) {
    if (countdownData.interval) {
        clearInterval(countdownData.interval);
        countdownData.interval = null;
    }

    logger.info(`Countdown started: ${countdownData.title} (${countdownData.remainingTime / 1000}s remaining)`);

    const generation = (countdownData.generation || 0) + 1;
    countdownData.generation = generation;
    const isCurrent = () => activeCountdowns.get(countdownId) === countdownData
        && countdownData.generation === generation && !countdownData.isPaused;

    countdownData.interval = setInterval(() => {
        if (!isCurrent() || countdownData.tickPromise || countdownData.controlPromise) return;
        const tick = (async () => {
            try {
                const now = Date.now();
                const remaining = Math.max(0, countdownData.endTime - now);
                countdownData.remainingTime = remaining;

                if (remaining <= 0) {
                    // Stop before awaiting Discord: another 100ms tick must never
                    // queue a second final edit while this one is still pending.
                    countdownData.isFinishing = true;
                    clearInterval(countdownData.interval);
                    countdownData.interval = null;
                    const finishedEmbed = successEmbed(
                        `⏱️ ${countdownData.title} (Finished!)`,
                        "⏰ Time's up!",
                    );
                    await countdownData.message.edit({ embeds: [finishedEmbed], components: [] });
                    if (activeCountdowns.get(countdownId) === countdownData) cleanupCountdown(countdownId, activeCountdowns);
                    return;
                }

                if (now - countdownData.lastUpdate >= 1000) {
                    countdownData.lastUpdate = now;

                    const embed = successEmbed(
                        `⏱️ ${countdownData.title}`,
                        `Time remaining: **${formatTime(Math.ceil(remaining / 1000))}**`,
                    );

                    try {
                        await countdownData.message.edit({
                            embeds: [embed],
                            components: [
                                createControlButtons(
                                    countdownId,
                                    countdownData.isPaused,
                                ),
                            ],
                        });
                    } catch (error) {
                        logger.error("Error updating countdown message:", error);
                    }
                }
            } catch (error) {
                logger.error("Countdown update error:", error);
                if (isCurrent()) cleanupCountdown(countdownId, activeCountdowns);
            }
        })().finally(() => {
            if (countdownData.tickPromise === tick) countdownData.tickPromise = null;
        });
        countdownData.tickPromise = tick;
    }, 100);
}

function cleanupCountdown(countdownId, activeCountdowns) {
    const countdownData = activeCountdowns.get(countdownId);
    if (countdownData) {
        countdownData.generation = (countdownData.generation || 0) + 1;
        clearInterval(countdownData.interval);
        activeCountdowns.delete(countdownId);
    }
}

async function queueCountdownControl(countdownData, task) {
    const previous = countdownData.controlPromise || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    countdownData.controlPromise = current;
    try {
        return await current;
    } finally {
        if (countdownData.controlPromise === current) countdownData.controlPromise = null;
    }
}

async function countdownButtonHandler(interaction, client, args) {
    try {
        const { activeCountdowns } = await import('../commands/Tools/countdown.js');
        const action = args[0];
        const countdownId = args[1];

        const countdownData = activeCountdowns.get(countdownId);
        if (!countdownData) {
            return await interaction.reply({
                content: "This countdown has expired or was cancelled.",
                flags: ["Ephemeral"],
            });
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return await interaction.reply({
                content: 'You need the "Manage Messages" permission to control countdowns.',
                flags: ["Ephemeral"],
            });
        }

        if (!['pause', 'cancel'].includes(action)) return;
        // A slow countdown edit must not consume the component's 3s reply window.
        await interaction.deferReply({ flags: ["Ephemeral"] });

        await queueCountdownControl(countdownData, async () => {
            const expiredReply = () => interaction.editReply({
                content: "This countdown has expired or was cancelled.",
            });
            if (activeCountdowns.get(countdownId) !== countdownData) return expiredReply();
            if (countdownData.isFinishing || (!countdownData.isPaused && countdownData.endTime <= Date.now())) {
                // A final tick owns completion. A late click cannot restore its buttons.
                await countdownData.tickPromise;
                return expiredReply();
            }
            switch (action) {
                case "pause":
                    if (countdownData.isPaused) {
                        countdownData.generation = (countdownData.generation || 0) + 1;
                        await countdownData.tickPromise;
                        if (activeCountdowns.get(countdownId) !== countdownData) return expiredReply();
                        countdownData.isPaused = false;
                        countdownData.endTime = Date.now() + countdownData.remainingTime;
                        startCountdown(countdownId, countdownData, activeCountdowns);

                        const currentEmbed = countdownData.message.embeds[0];
                        await countdownData.message.edit({
                            embeds: [currentEmbed],
                            components: [createControlButtons(countdownId, false)],
                        });

                        await interaction.editReply({
                            content: "▶️ Countdown resumed!",
                        });
                    } else {
                        clearInterval(countdownData.interval);
                        countdownData.isPaused = true;
                        countdownData.remainingTime = countdownData.endTime - Date.now();
                        countdownData.generation = (countdownData.generation || 0) + 1;
                        await countdownData.tickPromise;
                        if (activeCountdowns.get(countdownId) !== countdownData) return expiredReply();

                        const currentEmbed = countdownData.message.embeds[0];
                        await countdownData.message.edit({
                            embeds: [currentEmbed],
                            components: [createControlButtons(countdownId, true)],
                        });

                        await interaction.editReply({
                            content: "⏸️ Countdown paused!",
                        });
                    }
                    break;

                case "cancel": {
                    clearInterval(countdownData.interval);
                    countdownData.generation = (countdownData.generation || 0) + 1;
                    await countdownData.tickPromise;
                    if (activeCountdowns.get(countdownId) !== countdownData) return expiredReply();

                    const embed = successEmbed(
                        `⏱️ ${countdownData.title} (Cancelled)`,
                        "The countdown was cancelled.",
                    );

                    await countdownData.message.edit({
                        embeds: [embed],
                        components: [],
                    });

                    cleanupCountdown(countdownId, activeCountdowns);

                    await interaction.editReply({
                        content: "❌ Countdown cancelled!",
                    });
                    break;
                }
            }
        });
    } catch (error) {
        logger.error('Countdown button handler error:', error);
        try {
            if (!interaction.replied) {
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred controlling the countdown.' });
            }
        } catch (err) {
            logger.error('Failed to send error message:', err);
        }
    }
}

export { createControlButtons, formatTime, startCountdown, cleanupCountdown, countdownButtonHandler };
export default countdownButtonHandler;
