import { EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { mutateTicketFeedback } from '../../../services/ticketFeedbackService.js';

const STAR_LABELS = {
    '1': '⭐ 1 — Poor',
    '2': '⭐ 2 — Below Average',
    '3': '⭐ 3 — Average',
    '4': '⭐ 4 — Good',
    '5': '⭐ 5 — Excellent',
};

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

        const submittedAt = new Date().toISOString();
        let result;
        try {
            result = await mutateTicketFeedback({
                guildId,
                channelId,
                userId: interaction.user.id,
                changes: { rating, submittedAt },
                onceFields: ['rating'],
            });
        } catch (error) {
            logger.warn('ticketFeedback: mutation failed', {
                guildId,
                channelId,
                userId: interaction.user.id,
                error: error.message,
                code: error.code,
            });

            if (error.code === 'TICKET_FEEDBACK_NOT_OWNER') {
                await interaction.followUp({
                    embeds: [feedbackEmbed(
                        '❌ Not Allowed',
                        error.userMessage,
                        getColor('error'),
                    )],
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
                return;
            }

            await editSurvey(interaction, {
                embeds: [feedbackEmbed(
                    error.code === 'TICKET_FEEDBACK_NOT_FOUND'
                        ? '⚠️ Ticket Not Found'
                        : '⚠️ Feedback Not Saved',
                    error.userMessage || 'Cloudy could not save your feedback. Please try again.',
                    getColor('error'),
                )],
                components: [],
            });
            return;
        }

        const ticketData = result.ticketData;

        if (result.status === 'already_submitted') {
            const existingRating = ticketData.feedback?.rating;
            const existingLabel = STAR_LABELS[String(existingRating)] || `${existingRating} stars`;
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
    },
};
