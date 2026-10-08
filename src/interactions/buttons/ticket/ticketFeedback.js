import { EmbedBuilder, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { mutateTicketFeedback } from '../../../services/ticketFeedbackService.js';
import { logger } from '../../../utils/logger.js';
import { getColor } from '../../../config/bot.js';
import { logTicketFeedback } from '../../../utils/ticket/ticketLogging.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';

const STAR_LABELS = {
    '1': '⭐ 1 — Poor',
    '2': '⭐ 2 — Below Average',
    '3': '⭐ 3 — Average',
    '4': '⭐ 4 — Good',
    '5': '⭐ 5 — Excellent',
};

const feedbackHandler = {
    name: 'ticket_feedback',

    async execute(interaction, client, args) {
        
        const [guildId, channelId, ratingStr] = args;

        if (!guildId || !channelId || !ratingStr) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [
                    new EmbedBuilder()
                        .setTitle('⚠️ Invalid Feedback Link')
                        .setDescription('This feedback link appears to be malformed.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        try {
            await interaction.deferUpdate();
        } catch (err) {
            logger.warn('ticketFeedback: interaction expired before deferUpdate', { guildId, channelId, error: err.message });
            return;
        }

        const rating = parseInt(ratingStr, 10);
        const ratingLabel = STAR_LABELS[String(rating)] ?? `${rating} stars`;
        let result;
        try {
            result = await mutateTicketFeedback({
                guildId,
                channelId,
                userId: interaction.user.id,
                changes: { rating, submittedAt: new Date().toISOString() },
                onceFields: ['rating'],
            });
        } catch (error) {
            logger.warn('ticketFeedback: mutation failed', { guildId, channelId, error: error.message, code: error.code });
            const notFound = error.code === 'TICKET_FEEDBACK_NOT_FOUND';
            const notOwner = error.code === 'TICKET_FEEDBACK_NOT_OWNER';
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    new EmbedBuilder()
                        .setTitle(notFound ? '⚠️ Ticket Not Found' : notOwner ? '❌ Not Allowed' : '⚠️ Feedback Not Saved')
                        .setDescription(notFound
                            ? 'Could not find the ticket associated with this survey.'
                            : notOwner
                                ? 'Only the ticket creator can submit feedback for this ticket.'
                                : error.userMessage || 'Cloudy could not save your feedback. Please try again.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        const ticketData = result.ticketData;
        if (result.status === 'already_submitted') {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    new EmbedBuilder()
                        .setTitle('✅ Already Submitted')
                        .setDescription(`You already rated this ticket **${STAR_LABELS[String(ticketData.feedback.rating)]}**.\nThank you for your feedback!`)
                        .setColor(getColor('success')),
                ],
                components: [],
            });
            return;
        }

        try {
            await logTicketFeedback({
                client: interaction.client,
                guildId,
                ticketNumber: ticketData.id,
                ticketChannelId: channelId,
                userId: interaction.user.id,
                rating,
            });
        } catch (err) {
            logger.warn('ticketFeedback: failed to send log', { guildId, channelId, error: err.message });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                new EmbedBuilder()
                    .setTitle('✅ Thanks for your feedback!')
                    .setDescription(`You rated your support experience **${ratingLabel}**.\n\nYour feedback has been recorded and helps us improve!`)
                    .setColor(getColor('success'))
                    .setFooter({ text: 'Thank you for using our support system.' })
                    .setTimestamp(),
            ],
            components: [],
        });

        logger.info('Ticket feedback submitted', {
            guildId,
            channelId,
            userId: interaction.user.id,
            rating,
        });
    },
};

const commentHandler = {
    name: 'ticket_feedback_comment',

    async execute(interaction, client, args) {
        const [guildId, channelId] = args;

        if (!guildId || !channelId) {
            await interaction.update({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('⚠️ Invalid Feedback Link')
                        .setDescription('This feedback action appears to be malformed.')
                        .setColor(getColor('error')),
                ],
                components: [],
            });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId(`ticket_feedback_comment_modal:${guildId}:${channelId}`)
            .setTitle('Add Ticket Feedback');

        const commentInput = new TextInputBuilder()
            .setCustomId('feedback_comment')
            .setLabel('Your feedback')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Share what went well or how we can improve...')
            .setRequired(true)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(commentInput));

        await interaction.showModal(modal);
    },
};

const declineHandler = {
    name: 'ticket_feedback_decline',

    async execute(interaction) {
        await interaction.update({
            embeds: [
                new EmbedBuilder()
                    .setTitle('👋 No problem!')
                    .setDescription('You can always reach out again if you need further support.')
                    .setColor(getColor('default')),
            ],
            components: [],
        });
    },
};

export default [feedbackHandler, commentHandler, declineHandler];
