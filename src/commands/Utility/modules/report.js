import { createEmbed } from '../../../utils/embeds.js';
import { logEvent, EVENT_TYPES } from '../../../services/loggingService.js';
import { formatLogLine, resolveUserAuthor } from '../../../utils/logging/logEmbeds.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { logger } from '../../../utils/logger.js';

export default {
    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        if (!deferSuccess) {
            logger.warn('Report interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId });
            return;
        }

        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');
        const messageLink = interaction.options.getString('message_link');
        const evidence = interaction.options.getAttachment('evidence');
        const guildId = interaction.guildId;

        let reportedMessage = null;
        if (messageLink) {
            const match = messageLink.match(
                /^https?:\/\/(?:canary\.|ptb\.)?(?:discord\.com|discordapp\.com)\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/?(?:\?.*)?)?$/
            );

            if (!match || match[1] !== guildId) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'Please provide a valid message link from this server.',
                });
            }

            const reportSourceChannel = await interaction.guild.channels.fetch(match[2]).catch(() => null);
            reportedMessage = await reportSourceChannel?.messages?.fetch(match[3]).catch(() => null);

            if (!reportedMessage) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.VALIDATION,
                    message: 'I could not access that message. Check the link and my channel permissions.',
                });
            }
        }

        const ownerMention = interaction.guild.ownerId
            ? `<@${interaction.guild.ownerId}> New report!`
            : 'New report!';

        const reportAttachments = [];
        if (evidence) {
            reportAttachments.push({
                attachment: evidence.url,
                name: evidence.name || 'report-evidence',
            });
        }
        if (reportedMessage) {
            for (const attachment of reportedMessage.attachments.values()) {
                if (reportAttachments.length >= 10) break;
                reportAttachments.push({
                    attachment: attachment.url,
                    name: attachment.name || 'reported-attachment',
                });
            }
        }

        const lines = [
            formatLogLine('Reported User', `${targetUser.tag} (\`${targetUser.id}\`)`),
            formatLogLine('Reported By', `${interaction.user.tag} (\`${interaction.user.id}\`)`),
            formatLogLine('Report Channel', interaction.channel.toString()),
        ];

        if (reportedMessage) {
            lines.push(
                formatLogLine('Message Author', `${reportedMessage.author.tag} (\`${reportedMessage.author.id}\`)`),
                formatLogLine('Message Channel', reportedMessage.channel.toString()),
                formatLogLine('Message Link', reportedMessage.url),
            );
        }

        const blockFields = [{ name: 'Reason', value: reason }];
        if (reportedMessage?.content) {
            blockFields.push({
                name: 'Reported Message',
                value: reportedMessage.content.slice(0, 1024),
            });
        }
        if (reportAttachments.length > 0) {
            blockFields.push({
                name: 'Picture / Evidence',
                value: `${reportAttachments.length} attachment${reportAttachments.length === 1 ? '' : 's'} included below.`,
            });
        }

        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.REPORT_FILE,
            content: ownerMention,
            attachments: reportAttachments,
            data: {
                title: 'Message / Picture Report',
                lines,
                blockFields,
                author: await resolveUserAuthor(client, targetUser.id),
                thumbnail: targetUser.displayAvatarURL(),
            },
        });

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [createEmbed({
                title: 'Report Submitted',
                description: `Your report against **${targetUser.tag}** has been successfully filed and sent to the moderation team. Thank you!`,
            })],
        });

        logger.info('Report submitted', {
            userId: interaction.user.id,
            reportedUserId: targetUser.id,
            guildId,
            reasonLength: reason.length,
        });
    },
};
