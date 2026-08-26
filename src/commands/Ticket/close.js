import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import {
    buildCloudyTicketEmbed,
    scheduleTicketReplyDeletion,
} from '../../utils/ticket/ticketBranding.js';
import { closeTicket } from '../../services/ticketReliabilityService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('close')
        .setDescription('Closes the current ticket.')
        .setDMPermission(false)
        .addStringOption((option) =>
            option
                .setName('reason')
                .setDescription('The reason for closing the ticket.')
                .setRequired(false),
        ),

    async execute(interaction, guildConfig, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        const permissionContext = await getTicketPermissionContext({ client, interaction });
        if (!permissionContext.ticketData) {
            return await replyUserError(interaction, {
                type: ErrorTypes.VALIDATION,
                message: 'This command can only be used in a valid ticket channel.',
            });
        }

        if (!permissionContext.canCloseTicket) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the `Manage Channels` permission, the configured `Ticket Staff Role`, or be the ticket creator to close this ticket.',
            });
        }

        const reason = interaction.options?.getString('reason') || 'No reason provided.';
        await closeTicket(interaction.channel, interaction.user, reason);

        await InteractionHelper.safeEditReply(interaction, {
            content: '',
            embeds: [buildCloudyTicketEmbed({
                title: 'Ticket closed',
                description: 'This ticket has been closed successfully.',
            })],
            components: [],
        });
        scheduleTicketReplyDeletion(interaction);

        logger.info('Ticket closed successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            reason,
            commandName: 'close',
        });
    },
};
