import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getTicketPermissionContext } from '../../utils/ticket/ticketPermissions.js';
import {
    buildCloudyTicketEmbed,
    scheduleTicketReplyDeletion,
} from '../../utils/ticket/ticketBranding.js';
import { PRIORITY_MAP } from '../../utils/helpers.js';
import { updateTicketPriority } from '../../services/ticketReliabilityService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('priority')
        .setDescription('Sets the priority level for the current support ticket.')
        .addStringOption((option) =>
            option
                .setName('level')
                .setDescription('The priority level for the ticket.')
                .setRequired(true)
                .addChoices(
                    { name: 'High', value: 'high' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'Low', value: 'low' },
                    { name: 'None', value: 'none' },
                ),
        )
        .setDMPermission(false),
    category: 'Ticket',

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

        if (!permissionContext.canManageTicket) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the `Manage Channels` permission or the configured `Ticket Staff Role` to change ticket priority.',
            });
        }

        const priorityLevel = interaction.options.getString('level');
        const priorityInfo = PRIORITY_MAP[priorityLevel];
        await updateTicketPriority(interaction.channel, priorityLevel, interaction.user);

        await InteractionHelper.safeEditReply(interaction, {
            content: '',
            embeds: [buildCloudyTicketEmbed({
                title: 'Priority Updated',
                description: `Ticket priority has been set to **${priorityInfo.emoji} ${priorityInfo.label}**.`,
            })],
            components: [],
        });
        scheduleTicketReplyDeletion(interaction);

        logger.info('Ticket priority updated successfully', {
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            channelId: interaction.channel.id,
            channelName: interaction.channel.name,
            guildId: interaction.guildId,
            priority: priorityLevel,
            commandName: 'priority',
        });
    },
};
