import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { ModerationService } from '../../services/moderation/moderationService.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user from the server")
        .addStringOption(option =>
            option
                .setName("target")
                .setDescription("Search for the banned user")
                .setRequired(true)
                .setAutocomplete(true),
        )
        .addStringOption(option =>
            option.setName("reason")
                .setDescription("Reason for the unban")
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    category: "moderation",

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const bans = await interaction.guild.bans.fetch().catch(() => null);

        if (!bans) {
            await interaction.respond([]).catch(() => {});
            return;
        }

        const choices = bans
            .filter(({ user }) => {
                const searchable = [
                    user.id,
                    user.username,
                    user.globalName,
                    user.tag,
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();

                return !focused || searchable.includes(focused);
            })
            .first(25)
            .map(({ user }) => ({
                name: `${user.tag} • ${user.id}`.slice(0, 100),
                value: user.id,
            }));

        await interaction.respond(choices).catch(() => {});
    },

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Unban interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'unban',
            });
            return;
        }

        const rawTarget = interaction.options.getString("target").trim();
        const normalizedTarget = rawTarget.replace(/[<@!>]/g, '').trim();
        const bans = await interaction.guild.bans.fetch().catch(() => null);
        const banInfo = bans?.get(normalizedTarget) || bans?.find(({ user }) =>
            [user.username, user.globalName, user.tag]
                .filter(Boolean)
                .some(value => value.toLowerCase() === rawTarget.toLowerCase())
        );
        const targetUser = banInfo?.user || null;

        if (!targetUser) {
            return replyUserError(interaction, {
                type: ErrorTypes.USER_INPUT,
                message: 'That user was not found in the server ban list.',
            });
        }

        const reason = interaction.options.getString("reason") || "No reason provided";
        const suppressionKey = `${interaction.guildId}:${targetUser.id}`;
        const suppressionExpiresAt = Date.now() + 15000;

        client.commandUnbanLogSuppressions ??= new Map();
        client.commandUnbanLogSuppressions.set(suppressionKey, suppressionExpiresAt);

        let result;
        try {
            result = await ModerationService.unbanUser({
                guild: interaction.guild,
                user: targetUser,
                moderator: interaction.member,
                reason,
            });
        } catch (error) {
            client.commandUnbanLogSuppressions.delete(suppressionKey);
            throw error;
        }

        const cleanupTimer = setTimeout(() => {
            if (client.commandUnbanLogSuppressions?.get(suppressionKey) === suppressionExpiresAt) {
                client.commandUnbanLogSuppressions.delete(suppressionKey);
            }
        }, 16000);
        cleanupTimer.unref?.();

        const moderatorName = interaction.member?.displayName
            || interaction.user.globalName
            || interaction.user.username;

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                successEmbed(
                    `User unbanned by ${moderatorName}`,
                    `Successfully unbanned **${targetUser.tag}** from the server.\n\n**Reason:** ${reason}\n**Case ID:** #${result.caseId}`,
                ),
            ],
        });
    },
};
