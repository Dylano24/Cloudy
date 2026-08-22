import { EmbedBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { mutateTicketFeedback } from '../../../services/ticketFeedbackService.js';

function buildEmbed(title, description, color) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color);
}

export default {
    name: 'ticket_feedback_comment_modal',

    async execute(interaction, client, args) {
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [buildEmbed(
                    '⚠️ Invalid Feedback Submission',
                    'This feedback form appears to be malformed.',
                    getColor('error'),
                )],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const comment = interaction.fields.getTextInputValue('feedback_comment')?.trim();
        if (!comment) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [buildEmbed(
                    '⚠️ Empty Feedback',
                    'Please enter a comment before submitting your feedback.',
                    getColor('warning'),
                )],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const commentSubmittedAt = new Date().toISOString();
        let result;

        try {
            result = await mutateTicketFeedback({
                guildId,
                channelId,
                userId: interaction.user.id,
                changes: { comment, commentSubmittedAt },
                onceFields: ['comment'],
            });
        } catch (error) {
            logger.warn('ticketFeedbackComment: mutation failed', {
                guildId,
                channelId,
                userId: interaction.user.id,
                error: error.message,
                code: error.code,
            });

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [buildEmbed(
                    error.code === 'TICKET_FEEDBACK_NOT_OWNER'
                        ? '❌ Not Allowed'
                        : error.code === 'TICKET_FEEDBACK_NOT_FOUND'
                            ? '⚠️ Ticket Not Found'
                            : '⚠️ Feedback Not Saved',
                    error.userMessage || 'Cloudy could not save your feedback. Please try again.',
                    getColor('error'),
                )],
            });
            return;
        }

        const ticketData = result.ticketData;

        if (result.status === 'already_submitted') {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [buildEmbed(
                    '✅ Already Submitted',
                    'Your written feedback for this ticket has already been recorded.',
                    getColor('success'),
                )],
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
                rating: ticketData.feedback?.rating ?? null,
                comment,
            });
        } catch (err) {
            logger.warn('ticketFeedbackComment: feedback saved but log delivery failed', {
                guildId,
                channelId,
                error: err.message,
            });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [buildEmbed(
                '✅ Feedback Submitted',
                'Your written feedback has been recorded. Thank you for helping us improve!',
                getColor('success'),
            )],
        });

        logger.info('Ticket feedback comment submitted', {
            guildId,
            channelId,
            userId: interaction.user.id,
            commentSubmittedAt,
        });
    },
};
