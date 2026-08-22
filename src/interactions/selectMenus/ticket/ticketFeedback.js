import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getTicketData, saveTicketData } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';

const STAR_LABELS = {
    '1': '⭐ 1 — Poor',
    '2': '⭐ 2 — Below Average',
    '3': '⭐ 3 — Average',
    '4': '⭐ 4 — Good',
    '5': '⭐ 5 — Excellent',
};

const feedbackQueues = new Map();

function enqueueFeedback(key, operation) {
    const previous = feedbackQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    feedbackQueues.set(key, current);
    current.finally(() => {
        if (feedbackQueues.get(key) === current) feedbackQueues.delete(key);
    }).catch(() => {});
    return current;
}

function feedbackEmbed(title, description, color) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color);
}

async function editSurvey(interaction, payload) {
    return interaction.editReply(payload).catch(error => {
        logger.warn('ticketFeedback: failed to edit survey response', {
            guildId: interaction.guildId,
            error: error.message,
        });
    });
}

export default {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        try {
            await interaction.deferUpdate();
        } catch (error) {
            logger.warn('ticketFeedback: failed to acknowledge interaction', {
                guildId: interaction.guildId,
                error: error.message,
            });
            return;
        }

        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await editSurvey(interaction, {
                embeds: [feedbackEmbed(
                    '⚠️ Invalid Feedback Link',
                    'This feedback link appears to be malformed.',
                    getColor('error'),
                )],
                components: [],
            });
            return;
        }

        const rating = Number.parseInt(interaction.values?.[0], 10);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            await editSurvey(interaction, {
                embeds: [feedbackEmbed(
                    '⚠️ Invalid Rating',
                    'Please select a rating between 1 and 5.',
                    getColor('error'),
                )],
                components: [],
            });
            return;
        }

        const queueKey = `${guildId}:${channelId}`;

        return enqueueFeedback(queueKey, async () => {
            let ticketData;
            try {
                ticketData = await getTicketData(guildId, channelId);
            } catch (err) {
                logger.warn('ticketFeedback: failed to load ticket data', {
                    guildId,
                    channelId,
                    error: err.message,
                });
                await editSurvey(interaction, {
                    embeds: [feedbackEmbed(
                        '⚠️ Feedback Unavailable',
                        'Cloudy could not verify this ticket right now. Please try again.',
                        getColor('error'),
                    )],
                    components: [],
                });
                return;
            }

            if (!ticketData) {
                await editSurvey(interaction, {
                    embeds: [feedbackEmbed(
                        '⚠️ Ticket Not Found',
                        'Could not find the ticket associated with this survey.',
                        getColor('error'),
                    )],
                    components: [],
                });
                return;
            }

            if (interaction.user.id !== ticketData.userId) {
                await interaction.followUp({
                    embeds: [feedbackEmbed(
                        '❌ Not Allowed',
                        'Only the ticket creator can submit feedback for this ticket.',
                        getColor('error'),
                    )],
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
                return;
            }

            if (ticketData.feedback?.rating) {
                const existingLabel = STAR_LABELS[String(ticketData.feedback.rating)]
                    || `${ticketData.feedback.rating} stars`;
                await editSurvey(interaction, {
                    embeds: [feedbackEmbed(
                        '✅ Already Submitted',
                        `You already rated this ticket **${existingLabel}**.\nThank you for your feedback!`,
                        getColor('success'),
                    )],
                    components: [],
                });
                return;
            }

            const submittedAt = new Date().toISOString();
            ticketData.feedback = { rating, submittedAt };

            try {
                await saveTicketData(guildId, channelId, ticketData);
            } catch (err) {
                logger.error('ticketFeedback: failed to save feedback', {
                    guildId,
                    channelId,
                    rating,
                    error: err.message,
                });
                await editSurvey(interaction, {
                    embeds: [feedbackEmbed(
                        '⚠️ Feedback Not Saved',
                        'Cloudy could not save your feedback. Please try again.',
                        getColor('error'),
                    )],
                    components: [],
                });
                return;
            }

            try {
                await logTicketFeedback({
                    client: interaction.client,
                    guildId,
                    ticketNumber: ticketData.ticketNumber || ticketData.id,
                    ticketChannelId: channelId,
                    userId: interaction.user.id,
                    rating,
                });
            } catch (err) {
                // Persistence is authoritative. A failed secondary log must not
                // make the user resubmit and create duplicate feedback records.
                logger.warn('ticketFeedback: feedback saved but log delivery failed', {
                    guildId,
                    channelId,
                    error: err.message,
                });
            }

            const ratingLabel = STAR_LABELS[String(rating)] ?? `${rating} stars`;
            const thankYouEmbed = new EmbedBuilder()
                .setTitle('✅ Thanks for your feedback!')
                .setDescription(`You rated your support experience **${ratingLabel}**.\n\nYour feedback has been recorded and helps us improve!`)
                .setColor(getColor('success'))
                .setFooter({ text: 'Thank you for using our support system.' })
                .setTimestamp();

            await editSurvey(interaction, {
                embeds: [thankYouEmbed],
                components: [],
            });

            logger.info('Ticket feedback submitted', {
                guildId,
                channelId,
                userId: interaction.user.id,
                rating,
                submittedAt,
            });
        });
    },
};
