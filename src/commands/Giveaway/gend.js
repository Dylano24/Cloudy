import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { canManageGiveaways, finishGiveaway } from '../../services/giveawayActions.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('gend')
        .setDescription('Ends an active giveaway now and announces the winner(s).')
        .addStringOption(option => option
            .setName('messageid')
            .setDescription('The message ID of the giveaway to end.')
            .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!interaction.inGuild()) {
            throw new CloudyError('Giveaway command used outside guild', ErrorTypes.VALIDATION,
                'This command can only be used in a server.', { userId: interaction.user.id });
        }
        if (!canManageGiveaways(interaction.member, interaction.guild)) {
            throw new CloudyError('User cannot manage giveaways', ErrorTypes.PERMISSION,
                'Only staff can manage giveaways.', { userId: interaction.user.id, guildId: interaction.guildId });
        }
        const messageId = String(interaction.options.getString('messageid') || '').trim();
        if (!/^\d{17,20}$/.test(messageId)) {
            throw new CloudyError('Invalid message ID format', ErrorTypes.VALIDATION,
                'Please provide a valid message ID.', { providedId: messageId });
        }
        const { winners } = await finishGiveaway(interaction.client, interaction.guild, messageId, { endedBy: interaction.user.id });
        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed('Giveaway Ended', winners.length
                ? `Winner${winners.length === 1 ? '' : 's'}: ${winners.map(id => `<@${id}>`).join(', ')}`
                : 'Nobody entered, so there is no winner.')],
            flags: MessageFlags.Ephemeral,
        });
    },
};
