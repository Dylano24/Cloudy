import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { canManageGiveaways, rerollGiveaway } from '../../services/giveawayActions.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('greroll')
        .setDescription('Draws new winner(s) for an ended giveaway.')
        .addStringOption(option => option
            .setName('messageid')
            .setDescription('The message ID of the ended giveaway.')
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
        const { winners } = await rerollGiveaway(interaction.client, interaction.guild, messageId, { rerolledBy: interaction.user.id });
        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed('Success', `New winner${winners.length === 1 ? '' : 's'}: ${winners.map(id => `<@${id}>`).join(', ')}`)],
            flags: MessageFlags.Ephemeral,
        });
    },
};
